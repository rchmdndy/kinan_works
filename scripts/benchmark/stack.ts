import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
export const root = resolve(import.meta.dir, '../..');
export type State = {
  project: string;
  slice: string;
  dir: string;
  httpPort: number;
  mqttPort: number;
  password: string;
  encryption: string;
  ingest: string;
};
export async function command(
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const child = Bun.spawn(args, {
    cwd: root,
    env: env ?? process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code)
    throw new Error(`${args.slice(0, 3).join(' ')} failed (${code}): ${err}`);
  return out.trim();
}
export function loadState(path: string): State {
  const s = JSON.parse(readFileSync(resolve(path), 'utf8')) as State;
  if (
    !/^kinanbench[a-f0-9]{12}$/.test(s.project) ||
    s.slice !== `${s.project}.slice` ||
    s.dir !== resolve(root, '.benchmark', s.project) ||
    realpathSync(s.dir) !== s.dir
  )
    throw new Error('Invalid benchmark isolation state');
  return s;
}
export function compose(s: State, args: string[]) {
  // Explicit allowlist: no inherited demo COMPOSE_*, DOCKER_HOST or .env.
  const env = {
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
    BENCH_PROJECT: s.project,
    BENCH_SLICE: s.slice,
    BENCH_DIR: s.dir,
    BENCH_HTTP_PORT: String(s.httpPort),
    BENCH_MQTT_PORT: String(s.mqttPort),
    MQTT_INGEST_USERNAME: 'benchmark-ingest',
    MQTT_INGEST_PASSWORD: s.ingest,
    ENCRYPTION_KEY_BASE64: s.encryption,
  };
  return command(
    [
      'docker',
      '--context',
      'default',
      'compose',
      '--env-file',
      '/dev/null',
      '-f',
      `${root}/docker-compose.benchmark.yml`,
      '-p',
      s.project,
      ...args,
    ],
    env,
  );
}
export function bootstrapScript(password: string) {
  return `const {Database}=require('bun:sqlite');const db=new Database('/data/benchmark.sqlite');
if(db.query('SELECT count(*) AS n FROM devices').get().n || db.query('SELECT count(*) AS n FROM telemetry').get().n)throw Error('Benchmark devices and telemetry must be empty');
const users=db.query('SELECT username,password_hash,active FROM users').all();
if(users.length){if(users.length!==1 || users[0].username!=='benchmark' || users[0].active!==1 || !await Bun.password.verify(${JSON.stringify(password)},users[0].password_hash))throw Error('Existing benchmark operator does not match');}
else {const t=Date.now();db.query('INSERT INTO users (id,username,display_name,password_hash,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(),'benchmark','Benchmark',await Bun.password.hash(${JSON.stringify(password)},'argon2id'),1,t,t);}db.close();`;
}
export async function preflight() {
  const info = JSON.parse(
    await command([
      'docker',
      '--context',
      'default',
      'info',
      '--format',
      '{{json .}}',
    ]),
  );
  if (
    info.CgroupDriver !== 'systemd' ||
    info.CgroupVersion !== '2' ||
    info.SecurityOptions.some((v: string) => v.includes('rootless'))
  )
    throw new Error(
      'Requires local rootful Docker with systemd cgroup v2; aggregate cap cannot be enforced on this host',
    );
  const endpoint = await command([
    'docker',
    'context',
    'inspect',
    'default',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]);
  if (!endpoint.startsWith('unix://'))
    throw new Error('Only local Unix Docker is supported');
  if (!existsSync('/sys/fs/cgroup/cgroup.controllers'))
    throw new Error('Host cgroup v2 mount unavailable');
}
export function assertCap(s: State) {
  const path = `/sys/fs/cgroup/${s.slice}`;
  if (!existsSync(`${path}/cpu.max`))
    throw new Error(
      'Aggregate cgroup cap unavailable. Run sudo -v and stack.ts up first; refusing an uncapped benchmark.',
    );
  const [quota, period] = readFileSync(`${path}/cpu.max`, 'utf8')
    .trim()
    .split(/\s+/)
    .map(Number);
  if (
    quota / period !== 1 ||
    readFileSync(`${path}/memory.max`, 'utf8').trim() !== '1610612736' ||
    readFileSync(`${path}/memory.swap.max`, 'utf8').trim() !== '0'
  )
    throw new Error(
      'Aggregate cap missing/changed: require CPUQuota=100%, MemoryMax=1536M and MemorySwapMax=0',
    );
  if (readFileSync('/proc/self/cgroup', 'utf8').includes(s.slice))
    throw new Error('Generator must run outside server slice');
  return path;
}
export async function containers(s: State) {
  const ids = (await compose(s, ['ps', '-a', '-q']))
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length !== 4)
    throw new Error(
      `Expected exactly four isolated server containers, found ${ids.length}`,
    );
  const rows = JSON.parse(
    await command(['docker', '--context', 'default', 'inspect', ...ids]),
  );
  for (const c of rows) {
    if (
      c.Config.Labels['com.docker.compose.project'] !== s.project ||
      c.HostConfig.CgroupParent !== s.slice ||
      !c.State.Running
    )
      throw new Error('Container isolation/running state verification failed');
    const membership = readFileSync(
      `/proc/${c.State.Pid}/cgroup`,
      'utf8',
    ).trim();
    if (membership !== `0::/${s.slice}/docker-${c.Id}.scope`)
      throw new Error(`Unexpected cgroup membership: ${membership}`);
  }
  return rows;
}
if (import.meta.main) {
  const [action, path] = process.argv.slice(2);
  if (action === 'init') {
    await preflight();
    const project = `kinanbench${randomBytes(6).toString('hex')}`;
    const dir = resolve(root, '.benchmark', project);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const sub of ['db', 'auth', 'results'])
      mkdirSync(`${dir}/${sub}`, { mode: 0o700 });
    const s: State = {
      project,
      dir,
      slice: `${project}.slice`,
      httpPort: 18080,
      mqttPort: 11883,
      password: randomBytes(24).toString('hex'),
      encryption: randomBytes(32).toString('base64'),
      ingest: randomBytes(24).toString('hex'),
    };
    writeFileSync(`${dir}/state.json`, JSON.stringify(s, null, 2), {
      mode: 0o600,
    });
    console.log(`${dir}/state.json`);
  } else if (action === 'preflight') {
    await preflight();
    console.log(
      'Local rootful Docker/systemd cgroup v2 supported. sudo is required to create the bounded slice.',
    );
  } else {
    if (!path)
      throw new Error(
        'Usage: bun scripts/benchmark/stack.ts init|preflight|up|check|down [state.json]',
      );
    const s = loadState(path);
    if (action === 'up') {
      await preflight();
      // Runtime-only unit; unique flat slice name avoids implicit nested slices.
      const unit = `/run/systemd/system/${s.slice}`;
      if (existsSync(unit))
        throw new Error('Slice already exists; use check or down, not up');
      const text = `[Unit]\nDescription=Isolated Grow Sense benchmark ${s.project}\n[Slice]\nCPUAccounting=yes\nMemoryAccounting=yes\nIOAccounting=yes\nCPUQuota=100%\nMemoryMax=1536M\nMemorySwapMax=0\n`;
      writeFileSync(`${s.dir}/slice.unit`, text, { mode: 0o600 });
      await command([
        'sudo',
        '-n',
        'install',
        '-m',
        '644',
        `${s.dir}/slice.unit`,
        unit,
      ]);
      await command(['sudo', '-n', 'systemctl', 'daemon-reload']);
      await command(['sudo', '-n', 'systemctl', 'start', s.slice]);
      assertCap(s);
      await compose(s, [
        'up',
        '-d',
        '--build',
        '--wait',
        '--wait-timeout',
        '120',
      ]);
      await containers(s);
      console.log('Isolated stack ready. Full workload has not run.');
    } else if (action === 'check') {
      await preflight();
      assertCap(s);
      await containers(s);
      console.log(
        'All four server containers are inside the verified aggregate cap; generator is outside.',
      );
    } else if (action === 'down') {
      await compose(s, ['down', '--volumes', '--timeout', '15']);
      await command(['sudo', '-n', 'systemctl', 'stop', s.slice]);
      await command([
        'sudo',
        '-n',
        'rm',
        '-f',
        `/run/systemd/system/${s.slice}`,
      ]);
      await command(['sudo', '-n', 'systemctl', 'daemon-reload']);
      console.log(
        `Removed only ${s.project} containers/network/volume/slice. Retained credentials, SQLite and results in ${s.dir}`,
      );
    } else throw new Error('Unknown action');
  }
}
