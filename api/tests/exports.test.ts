import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { MemoryTelemetryCache } from '../src/cache.js';

const dir = mkdtempSync(join(tmpdir(), 'kinan-exports-test-'));
// Stub mosquitto_passwd: broker sync requires a $7$-prefixed hash line.
// Invocation is `passwd -b -c <file> <username> <secret>`, so $4 is the
// username prefix and $5 the secret; printf keeps both $ signs via \$.
const passwdStub = join(dir, 'mosquitto_passwd');
writeFileSync(
  passwdStub,
  `#!/bin/sh
printf '%s:' "$4" > "$3"
printf "\\$7\\$" >> "$3"
printf '%s\\n' "$5" >> "$3"
`,
  { mode: 0o700 },
);
chmodSync(passwdStub, 0o700);

type FakeJob = {
  id: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  rowCount: number | null;
  error: string | null;
  fileBytes: number | null;
};

const jobs = new Map<string, { job: FakeJob; userId: string }>();
const created: Array<Record<string, unknown>> = [];

const exporter = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'GET' && path === '/internal/exports/health')
      return Response.json({ ok: true });
    if (request.method === 'POST' && path === '/internal/exports/') {
      const body = (await request.json()) as Record<string, unknown>;
      if (
        !body.userId ||
        !body.deviceId ||
        !Array.isArray(body.parameterIds) ||
        !body.parameterIds.length ||
        (body.start as number) >= (body.end as number)
      )
        return new Response('Invalid export request', { status: 400 });
      created.push(body);
      const job: FakeJob = {
        id: `job-${created.length}`,
        status: 'queued',
        rowCount: null,
        error: null,
        fileBytes: null,
      };
      jobs.set(job.id, { job, userId: body.userId as string });
      return Response.json({ job });
    }
    const single = /^\/internal\/exports\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && single) {
      const entry = jobs.get(single[1]!);
      if (!entry || entry.userId !== url.searchParams.get('userId'))
        return new Response('Export not found', { status: 404 });
      return Response.json({ job: entry.job });
    }
    const file = /^\/internal\/exports\/([^/]+)\/file$/.exec(path);
    if (request.method === 'GET' && file) {
      const entry = jobs.get(file[1]!);
      if (!entry || entry.userId !== url.searchParams.get('userId'))
        return new Response('Export not found', { status: 404 });
      if (entry.job.status !== 'ready')
        return new Response('Export is not ready', { status: 409 });
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      });
    }
    const list =
      request.method === 'GET' &&
      path === '/internal/exports/' &&
      url.searchParams.get('userId');
    if (list) {
      const mine = [...jobs.entries()]
        .filter(([, entry]) => entry.userId === list)
        .map(([id, entry]) => ({
          id,
          deviceId: 'device_1',
          deviceLabel: 'Device',
          parameterIds: ['parameter_1'],
          start: 0,
          end: 100,
          status: entry.job.status,
          rowCount: entry.job.rowCount,
          error: entry.job.error,
          fileBytes: entry.job.fileBytes,
          createdAt: 1,
          finishedAt: null,
        }));
      return Response.json({ exports: mine });
    }
    return new Response('Not found', { status: 404 });
  },
});

const env = {
  NODE_ENV: 'test',
  APP_ORIGIN: 'http://localhost:5173',
  SQLITE_PATH: join(dir, 'test.sqlite'),
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString('base64'),
  MQTT_INGEST_PASSWORD: 'x'.repeat(16),
  MOSQUITTO_PASSWD_BIN: passwdStub,
  MOSQUITTO_PASSWORD_FILE: join(dir, 'auth', 'passwd'),
  MOSQUITTO_ACL_FILE: join(dir, 'auth', 'acl'),
  EXPORTER_URL: `http://127.0.0.1:${exporter.port}`,
};

afterAll(() => {
  exporter.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe('export proxy routes', () => {
  test('requires authentication for all export routes', async () => {
    const service = await createApp(env, {
      cache: new MemoryTelemetryCache(),
      mqtt: false,
    });
    try {
      for (const path of ['/api/exports', '/api/exports/job-1']) {
        const response = await service.app.handle(
          new Request(`http://localhost${path}`),
        );
        expect(response.status).toBe(401);
      }
    } finally {
      await service.close();
    }
  });

  test('creates jobs for owned devices with CSRF and ownership', async () => {
    const service = await createApp(env, {
      cache: new MemoryTelemetryCache(),
      mqtt: false,
    });
    try {
      const now = Date.now();
      service.repository.createUser(
        {
          id: 'user-1',
          username: 'operator',
          displayName: 'Operator',
          active: true,
          createdAt: now,
          updatedAt: now,
        },
        await Bun.password.hash('correct horse battery staple', 'argon2id'),
      );
      const login = await service.app.handle(
        new Request('http://localhost/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'operator',
            password: 'correct horse battery staple',
          }),
        }),
      );
      const cookie = login.headers
        .getSetCookie()
        .map((line) => line.split(';')[0])
        .join('; ');
      const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;

      const createDevice = await service.app.handle(
        new Request('http://localhost/api/devices', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            'X-CSRF-Token': csrf,
            Origin: env.APP_ORIGIN,
          },
          body: JSON.stringify({
            label: 'Test device',
            parameters: [{ label: 'Temperature', unit: 'C', points: 1 }],
          }),
        }),
      );
      const deviceId = (
        (await createDevice.json()) as { device: { id: string } }
      ).device.id;

      // Missing CSRF must fail.
      const withoutCsrf = await service.app.handle(
        new Request('http://localhost/api/exports', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            Origin: env.APP_ORIGIN,
          },
          body: JSON.stringify({
            deviceId,
            parameterIds: ['parameter_1'],
            start: 0,
            end: 100,
          }),
        }),
      );
      expect(withoutCsrf.status).toBe(403);

      // Valid request forwards to the exporter.
      const created1 = await service.app.handle(
        new Request('http://localhost/api/exports', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            'X-CSRF-Token': csrf,
            Origin: env.APP_ORIGIN,
          },
          body: JSON.stringify({
            deviceId,
            parameterIds: ['parameter_1'],
            start: 0,
            end: 100,
          }),
        }),
      );
      expect(created1.status).toBe(201);
      const job = (await created1.json()) as {
        job: { id: string; status: string; deviceLabel: string };
      };
      expect(job.job.status).toBe('queued');
      expect(job.job.deviceLabel).toBe('Test device');
      expect(created).toHaveLength(1);
      expect(created[0]!.userId).toBe('user-1');
      expect(created[0]!.deviceId).toBe(deviceId);
      expect(created[0]!.parameterIds).toEqual(['parameter_1']);

      // Foreign device is rejected.
      const foreign = await service.app.handle(
        new Request('http://localhost/api/exports', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            'X-CSRF-Token': csrf,
            Origin: env.APP_ORIGIN,
          },
          body: JSON.stringify({
            deviceId: 'not-a-device',
            parameterIds: ['parameter_1'],
            start: 0,
            end: 100,
          }),
        }),
      );
      expect(foreign.status).toBe(404);

      // Status proxies the job.
      const status = await service.app.handle(
        new Request(
          `http://localhost/api/exports/${job.job.id}?userId=user-1`,
          { headers: { Cookie: cookie } },
        ),
      );
      expect(status.status).toBe(200);

      // List returns jobs for the user.
      const list = await service.app.handle(
        new Request('http://localhost/api/exports', {
          headers: { Cookie: cookie },
        }),
      );
      const listBody = (await list.json()) as {
        exports: Array<{ id: string }>;
      };
      expect(listBody.exports.map((item) => item.id)).toContain(job.job.id);

      // Download proxies the file bytes.
      jobs.get(job.job.id)!.job.status = 'ready';
      const file = await service.app.handle(
        new Request(
          `http://localhost/api/exports/${job.job.id}/file?userId=user-1`,
          { headers: { Cookie: cookie } },
        ),
      );
      expect(file.status).toBe(200);
      expect(file.headers.get('Content-Type')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    } finally {
      await service.close();
    }
  });
});
