import { writeFileSync, openSync, closeSync } from 'node:fs';
import { connect, type MqttClient } from '../../api/node_modules/mqtt';
import {
  assertCap,
  bootstrapScript,
  compose,
  containers,
  loadState,
  preflight,
} from './stack';
import {
  counters,
  interval,
  schedule,
  phase,
  phases,
  distribution,
  verify,
  type Counters,
} from './metrics';

const statePath = process.argv[2];
if (!statePath || process.argv[3] !== '--run-600s')
  throw new Error(
    'Usage: bun scripts/benchmark/run.ts <state.json> --run-600s (explicit full workload opt-in)',
  );
const runStartedAt = new Date();
const pad = (value: number) => String(value).padStart(2, '0');
const reportTimestamp = `${pad(runStartedAt.getDate())}-${pad(runStartedAt.getMonth() + 1)}-${runStartedAt.getFullYear()}-${pad(runStartedAt.getHours())}:${pad(runStartedAt.getMinutes())}:${pad(runStartedAt.getSeconds())}`;
const s = loadState(statePath);
await preflight();
const cgroup = assertCap(s);
await containers(s);
// Exclusive one-shot marker also prevents accidental reuse of populated data.
closeSync(openSync(`${s.dir}/run.lock`, 'wx', 0o600));
const url = `http://127.0.0.1:${s.httpPort}`;
const clients: MqttClient[] = [];
const abort = new AbortController();
const errors: { atMs: number | null; kind: string; message: string }[] = [];
let start: number | undefined;
const now = () => (start === undefined ? null : performance.now() - start);
const record = (kind: string, e: unknown) =>
  errors.push({ atMs: now(), kind, message: String(e) });
const stop = () => {
  record('interrupted', 'Signal received');
  abort.abort();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const jobs = schedule().map((j) => ({
  ...j,
  writeId: `${s.project}_${j.device}_${j.sequence}`,
  deviceId: '',
  sentAtMs: null as number | null,
  ackMs: null as number | null,
  sseMs: null as number | null,
  sseCount: 0,
}));
const byId = new Map(jobs.map((j) => [j.writeId, j]));
type Sample = {
  dueMs: number;
  atMs: number;
  elapsedMs: number;
  scope: string;
  cpuPercent: number;
  memoryBytes: number;
  readBytesPerSecond: number;
  writeBytesPerSecond: number;
  throttledUsec: number;
  oomKills: number;
  restarts: number;
};
const samples: Sample[] = [];
const streams: Promise<void>[] = [];
let cookie = '',
  csrf = '';
async function api(path: string, body?: unknown) {
  const response = await fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Cookie: cookie,
      Origin: url,
      'x-csrf-token': csrf,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: path.endsWith('/events')
      ? abort.signal
      : AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response;
}
async function waitUntil(deadline: number) {
  while (performance.now() < deadline) {
    if (abort.signal.aborted) throw new Error('Interrupted');
    await Bun.sleep(Math.min(100, deadline - performance.now()));
  }
}
async function dbRows() {
  const script = `const {Database}=require('bun:sqlite'); const db=new Database('/data/benchmark.sqlite',{readonly:true}); console.log(JSON.stringify(db.query('SELECT device_id,write_id,count(*) AS count FROM telemetry GROUP BY device_id,write_id').all()));db.close();`;
  return JSON.parse(
    await compose(s, ['exec', '-T', 'api', 'bun', '-e', script]),
  ) as { device_id: string; write_id: string; count: number }[];
}
let verification: ReturnType<typeof verify> | null = null;
let measuredEndMs: number | null = null;
let completed = false;
try {
  // Local administrative bootstrap, followed by real HTTP session + device creation.
  const script = bootstrapScript(s.password);
  await compose(s, ['exec', '-T', 'api', 'bun', '-e', script]);
  const login = await api('/api/auth/login', {
    username: 'benchmark',
    password: s.password,
  });
  cookie = login.headers
    .getSetCookie()
    .flatMap((value) => value.split(/, (?=kinan_)/))
    .map((value) => value.split(';')[0])
    .join('; ');
  csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
  const devices: {
    device: {
      id: string;
      credentialVersion: number;
      parameters: Record<string, unknown>;
    };
    secret: string;
  }[] = [];
  for (let i = 0; i < 20; i++)
    devices.push(
      await (
        await api('/api/devices', {
          label: `Benchmark ${i + 1}`,
          parameters: Array.from({ length: 5 }, (_, n) => ({
            label: `Sensor ${n + 1}`,
            unit: 'unit',
            points: 2,
          })),
        })
      ).json(),
    );
  await Bun.sleep(2500); // Allow broker's generation watcher to reload all real credentials.
  for (const [i, { device, secret }] of devices.entries()) {
    for (const j of jobs) if (j.device === i) j.deviceId = device.id;
    const client = connect(`mqtt://127.0.0.1:${s.mqttPort}`, {
      username: device.id,
      password: secret,
      clientId: `${s.project}-${i}`,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 10000,
      protocolVersion: 4,
    });
    clients.push(client);
    client.on('error', (e) => record('mqtt', e.message));
    client.on('offline', () => record('mqtt-offline', device.id));
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
      setTimeout(
        () => reject(new Error('Device MQTT authentication timeout')),
        12000,
      ).unref();
    });
    const response = await api(`/api/devices/${device.id}/events`);
    if (
      !response.body ||
      !response.headers.get('content-type')?.includes('text/event-stream')
    )
      throw new Error('SSE unavailable');
    let ready!: () => void;
    let fail!: (e: unknown) => void;
    const snapshot = new Promise<void>((resolve, reject) => {
      ready = resolve;
      fail = reject;
    });
    const task = (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const cancel = () => {
        void reader.cancel();
      };
      abort.signal.addEventListener('abort', cancel, { once: true });
      try {
        while (!abort.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) {
            if (!abort.signal.aborted) throw new Error('SSE closed');
            break;
          }
          buffer += decoder
            .decode(value, { stream: true })
            .replaceAll('\r\n', '\n');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = block
              .split('\n')
              .find((l) => l.startsWith('event:'))
              ?.slice(6)
              .trim();
            const data = block
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('\n');
            if (event === 'snapshot') ready();
            if (event === 'telemetry') {
              const packet = JSON.parse(data);
              const j = byId.get(packet.writeId);
              if (!j || j.deviceId !== device.id || j.sentAtMs === null) {
                record('unexpected-sse', packet.writeId);
                continue;
              }
              j.sseCount++;
              if (j.sseMs === null) j.sseMs = now()! - j.sentAtMs;
            }
          }
        }
      } finally {
        abort.signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
      }
    })().catch((e) => {
      fail(e);
      if (!abort.signal.aborted) record('sse', e);
    });
    streams.push(task);
    await Promise.race([
      snapshot,
      Bun.sleep(10000).then(() => {
        throw new Error('SSE snapshot timeout');
      }),
    ]);
  }
  await Bun.sleep(1000); // Snapshot is emitted just before Redis subscription; settle before timer.
  const initialContainers = await containers(s);
  const previous = new Map<string, { time: number; value: Counters }>();
  start = performance.now();
  for (const c of initialContainers)
    previous.set(c.Id, {
      time: start,
      value: counters(`${cgroup}/docker-${c.Id}.scope`),
    });
  previous.set('aggregate', { time: start, value: counters(cgroup) });
  const sampler = (async () => {
    for (let second = 1; second <= 600; second++) {
      await waitUntil(start! + second * 1000);
      try {
        assertCap(s);
        const rows = await containers(s);
        const entries = [
          {
            id: 'aggregate',
            scope: 'aggregate',
            path: cgroup,
            restarts: rows.reduce(
              (a: number, c: { RestartCount: number }) => a + c.RestartCount,
              0,
            ),
          },
          ...rows.map(
            (c: {
              Id: string;
              Config: { Labels: Record<string, string> };
              RestartCount: number;
            }) => ({
              id: c.Id,
              scope: c.Config.Labels['com.docker.compose.service'],
              path: `${cgroup}/docker-${c.Id}.scope`,
              restarts: c.RestartCount,
            }),
          ),
        ];
        for (const entry of entries) {
          const time = performance.now();
          const value = counters(entry.path);
          const old = previous.get(entry.id);
          if (!old) throw new Error('Container recreated during benchmark');
          const elapsedMs = time - old.time;
          samples.push({
            dueMs: second * 1000,
            atMs: time - start!,
            elapsedMs,
            scope: entry.scope,
            ...interval(old.value, value, elapsedMs),
            restarts: entry.restarts,
          });
          previous.set(entry.id, { time, value });
        }
        if (now()! - second * 1000 > 1000)
          record('sampling-late', `slot ${second}`);
      } catch (e) {
        record('sampling', e);
        throw e;
      }
    }
  })();
  // Attach rejection handler immediately; failure aborts publishers rather than running uncapped.
  const sampling = sampler.catch((e) => {
    abort.abort();
    throw e;
  });
  const publishing = (async () => {
    for (const j of jobs) {
      await waitUntil(start! + j.due);
      const at = now()!;
      // Never catch up missed intervals or send a previous phase's load in a later phase.
      if (at >= 600000 || at - j.due >= 3000 || phase(at) !== phase(j.due)) {
        record('missed-slot', j.writeId);
        continue;
      }
      const device = devices[j.device].device;
      const client = clients[j.device];
      if (!client.connected) {
        record('not-connected', j.writeId);
        continue;
      }
      const payload = {
        credentialVersion: device.credentialVersion,
        writeId: j.writeId,
        timestamp: Date.now(),
        values: Object.fromEntries(
          Object.keys(device.parameters).map((id, n) => [
            id,
            { status: 'ok', value: 20 + n + Math.sin(j.sequence / 10) },
          ]),
        ),
      };
      j.sentAtMs = now()!;
      client.publish(
        `devices/${device.id}/${device.credentialVersion}/telemetry`,
        JSON.stringify(payload),
        { qos: 1, retain: false },
        (e) => {
          if (e) record('publish', e.message);
          else j.ackMs = now()! - j.sentAtMs!;
        },
      );
    }
    await waitUntil(start! + 600000);
    measuredEndMs = now();
  })();
  await Promise.all([sampling, publishing]);
  // Drain outside measured window. SQLite verification includes every scheduled ID.
  const drainDeadline = performance.now() + 30000;
  do {
    verification = verify(jobs, await dbRows());
    if (
      verification.stored === jobs.filter((j) => j.sentAtMs !== null).length &&
      jobs
        .filter((j) => j.sentAtMs !== null)
        .every((j) => j.ackMs !== null && j.sseMs !== null)
    )
      break;
    await Bun.sleep(500);
  } while (performance.now() < drainDeadline);
  completed = true;
} catch (e) {
  measuredEndMs ??= now();
  record('fatal', e);
  process.exitCode = 1;
} finally {
  abort.abort();
  await Promise.all(
    clients.map((c) => c.endAsync(true).catch((e) => record('close', e))),
  );
  await Promise.allSettled(streams);
  try {
    verification = verify(jobs, await dbRows());
  } catch (e) {
    record('verification', e);
  }
  const summaries = phases.map((name) => {
    const messages = jobs.filter((j) => phase(j.due) === name);
    const resources = Object.fromEntries(
      ['aggregate', 'api', 'redis', 'mosquitto', 'nginx'].map((scope) => {
        // A sample belongs to the phase containing its scheduled interval start.
        const rows = samples.filter(
          (r) => r.scope === scope && phase(r.dueMs - 1) === name,
        );
        return [
          scope,
          Object.fromEntries(
            [
              'cpuPercent',
              'memoryBytes',
              'readBytesPerSecond',
              'writeBytesPerSecond',
              'throttledUsec',
              'oomKills',
              'restarts',
            ].map((key) => [
              key,
              distribution(rows.map((r) => r[key as keyof Sample] as number)),
            ]),
          ),
        ];
      }),
    );
    return {
      phase: name,
      expected: messages.length,
      scheduled:
        start === undefined
          ? 0
          : messages.filter((j) => j.due <= (measuredEndMs ?? now()!)).length,
      sent: messages.filter((j) => j.sentAtMs !== null).length,
      acknowledged: messages.filter((j) => j.ackMs !== null).length,
      stored: verification
        ? messages.filter(
            (j) =>
              !verification!.missing.includes(`${j.deviceId}/${j.writeId}`),
          ).length
        : null,
      sseReceived: messages.filter((j) => j.sseMs !== null).length,
      duplicateSse: messages.reduce(
        (sum, j) => sum + Math.max(0, j.sseCount - 1),
        0,
      ),
      brokerAckMs: distribution(
        messages.flatMap((j) => (j.ackMs === null ? [] : [j.ackMs])),
      ),
      publishToSseMs: distribution(
        messages.flatMap((j) => (j.sseMs === null ? [] : [j.sseMs])),
      ),
      scheduleLagMs: distribution(
        messages.flatMap((j) =>
          j.sentAtMs === null ? [] : [j.sentAtMs - j.due],
        ),
      ),
      resources,
      errors: errors.filter(
        (e) => e.atMs !== null && e.atMs < 600000 && phase(e.atMs) === name,
      ),
    };
  });
  const valid =
    completed &&
    errors.length === 0 &&
    verification?.missing.length === 0 &&
    verification?.duplicates.length === 0 &&
    verification?.unexpected.length === 0 &&
    samples.length === 3000 &&
    jobs.every((j) => j.ackMs !== null && j.sseCount === 1) &&
    samples.every((r) => r.oomKills === 0 && r.restarts === 0);
  const report = {
    project: s.project,
    runStartedAt: runStartedAt.toISOString(),
    reportTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    completed,
    valid,
    measuredEndMs,
    measuredDurationMs: 600000,
    expected: 2200,
    summaries,
    verification,
    errors,
    jobs,
    samples,
  };
  writeFileSync(
    `${s.dir}/results/${reportTimestamp}_report.json`,
    JSON.stringify(report, null, 2),
    { flag: 'wx' },
  );
  function csv(name: string, rows: Record<string, unknown>[]) {
    const keys = Object.keys(rows[0] ?? {});
    const cell = (v: unknown) => {
      const text =
        v === null || v === undefined
          ? ''
          : typeof v === 'object'
            ? JSON.stringify(v)
            : String(v);
      return `"${text.replaceAll('"', '""')}"`;
    };
    writeFileSync(
      `${s.dir}/results/${reportTimestamp}_${name}.csv`,
      [
        keys.map(cell).join(','),
        ...rows.map((row) => keys.map((k) => cell(row[k])).join(',')),
      ].join('\n') + '\n',
      { flag: 'wx' },
    );
  }
  csv('messages', jobs);
  csv('resources', samples);
  csv('phases', summaries);
  csv('errors', errors);
  writeFileSync(
    `${s.dir}/results/${reportTimestamp}_report.md`,
    `# Local IoT benchmark\n\nProject: ${s.project}\n\nCompleted: ${completed}; valid: ${valid}. Expected schedule: 2200; measured duration: 600 seconds.\n\n` +
      summaries
        .map(
          (p) =>
            `## ${p.phase}\n\nExpected/scheduled/sent/acknowledged/stored/SSE: ${p.expected}/${p.scheduled}/${p.sent}/${p.acknowledged}/${p.stored}/${p.sseReceived}\n\nBroker ACK p50/p95/p99 ms: ${p.brokerAckMs.p50}/${p.brokerAckMs.p95}/${p.brokerAckMs.p99}\n\nPublish-to-SSE p50/p95/p99 ms: ${p.publishToSseMs.p50}/${p.publishToSseMs.p95}/${p.publishToSseMs.p99}\n\nResources (p50/p95/p99/max and count, raw units in field names):\n\n\`\`\`json\n${JSON.stringify(p.resources, null, 2)}\n\`\`\`\n\nErrors: ${p.errors.length}\n`,
        )
        .join('\n') +
      `\n## Verification and errors\n\n\`\`\`json\n${JSON.stringify({ verification, errors }, null, 2)}\n\`\`\`\n\nTarget-load health test only; not maximum capacity or long-term stability evidence.\n`,
    { flag: 'wx' },
  );
  console.log(`Reports: ${s.dir}/results; valid=${valid}`);
  if (!valid) process.exitCode = 1;
}
