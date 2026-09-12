import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEMO_DEVICE_ID,
  DEMO_USER_ID,
  DEMO_PARAMETERS,
  seedDemo,
} from '../src/demo-seed.js';
import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
import { backupDatabase } from '../src/repository.js';
import { openDatabase, Repository } from '../src/repository.js';

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    ),
);

function envFor(directory: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    SQLITE_PATH: join(directory, 'kinan.sqlite'),
    ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 9).toString('base64'),
    MQTT_INGEST_PASSWORD: 'x'.repeat(16),
    MOSQUITTO_PASSWORD_FILE: join(directory, 'mqtt', 'passwd'),
    MOSQUITTO_ACL_FILE: join(directory, 'mqtt', 'acl'),
  };
}
const broker = { sync: async () => undefined };

test('demo seed is idempotent, uses fixed credentials, and creates no telemetry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kinan-demo-seed-'));
  directories.push(directory);
  const env = envFor(directory);
  const first = await seedDemo(env, { broker });
  const second = await seedDemo(env, { broker });

  expect(first).toMatchObject({
    users: 1,
    devices: 1,
    telemetry: 0,
    createdUser: true,
    createdDevice: true,
  });
  expect(second).toEqual({
    users: 1,
    devices: 1,
    telemetry: 0,
    createdUser: false,
    createdDevice: false,
  });

  const database = openDatabase(env.SQLITE_PATH!);
  const repository = new Repository(database);
  try {
    const user = repository.getUserByUsername('test@skripsi.com');
    expect(user).not.toBeNull();
    expect(user!.id).toBe('demo-user-v1');
    expect(
      await Bun.password.verify('loginlogin', user!.passwordHash),
    ).toBeTrue();
  } finally {
    repository.close();
  }

  const dry = await seedDemo(env, { dryRun: true, broker });
  expect(dry).toEqual({
    users: 1,
    devices: 1,
    telemetry: 0,
    createdUser: false,
    createdDevice: false,
  });
});

test('demo identity conflict is refused without replacing a device', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kinan-demo-conflict-'));
  directories.push(directory);
  const env = envFor(directory);
  const database = openDatabase(env.SQLITE_PATH!);
  const repository = new Repository(database);
  try {
    const now = Date.now();
    repository.createUser(
      {
        id: 'other-user',
        username: 'other',
        displayName: 'Other',
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      await Bun.password.hash('correct horse battery staple', 'argon2id'),
    );
    repository.saveDeviceBundle(
      {
        id: DEMO_DEVICE_ID,
        ownerUid: 'other-user',
        label: 'Not the demo device',
        active: true,
        credentialVersion: 1,
        createdAt: now,
        updatedAt: now,
        parameters: {},
      },
      { iv: 'unchanged', ciphertext: 'unchanged' },
    );
  } finally {
    repository.close();
  }
  await expect(seedDemo(env, { broker })).rejects.toThrow(
    'Refusing to overwrite conflicting device',
  );
  const check = openDatabase(env.SQLITE_PATH!);
  expect(new Repository(check).countUsers()).toBe(1);
  check.close();
});

function snapshot(database: Database): string {
  const tables = database
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return JSON.stringify(
    tables.map(({ name }) => [
      name,
      database.query(`SELECT * FROM "${name}" ORDER BY 1`).all(),
    ]),
  );
}

test('refresh repairs only owned parameters and preserves users, other devices, custom parameters and all history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kinan-demo-refresh-'));
  directories.push(directory);
  const env = envFor(directory);
  await seedDemo(env, { broker });
  const database = openDatabase(env.SQLITE_PATH!);
  const repository = new Repository(database);
  const demo = repository.getDevice(DEMO_DEVICE_ID)!;
  repository.createUser(
    {
      id: 'unrelated',
      username: 'demo',
      displayName: 'Not seeded',
      active: true,
      createdAt: 1,
      updatedAt: 1,
    },
    'untouched',
  );
  repository.saveDeviceBundle(
    { ...demo, id: 'other-device', ownerUid: 'unrelated' },
    { iv: 'other', ciphertext: 'other' },
  );
  const custom = {
    id: 'custom',
    label: 'Custom',
    unit: '',
    points: 0,
    type: 'nilai' as const,
  };
  repository.updateDevice(DEMO_DEVICE_ID, {
    parameters: {
      ...demo.parameters,
      custom,
      demo_setpoint: { ...DEMO_PARAMETERS.demo_setpoint, min: -10 },
    },
    active: false,
  });
  for (const id of [DEMO_DEVICE_ID, 'other-device'])
    repository.saveTelemetry(
      id,
      {
        writeId: 'history',
        timestamp: 1,
        credentialVersion: 1,
        values: { temperature: { status: 'ok', value: 20 } },
      },
      1,
    );
  const preserved = () =>
    JSON.stringify({
      users: database.query('SELECT * FROM users ORDER BY id').all(),
      other: database
        .query('SELECT * FROM devices WHERE id != ?')
        .all(DEMO_DEVICE_ID),
      history: database
        .query('SELECT * FROM telemetry ORDER BY device_id')
        .all(),
      latest: database
        .query('SELECT * FROM telemetry_latest ORDER BY device_id')
        .all(),
      secret: repository.getEncryptedSecret(DEMO_DEVICE_ID),
    });
  const before = preserved();
  await seedDemo(env, { broker });
  expect(preserved()).toBe(before);
  expect(repository.getDevice(DEMO_DEVICE_ID)!.parameters).toEqual({
    ...DEMO_PARAMETERS,
    custom,
  });
  const refreshed = snapshot(database);
  await seedDemo(env, { broker });
  expect(snapshot(database)).toBe(refreshed);
  database.close();
});

for (const conflict of ['username', 'id', 'parameters', 'marker'])
  test(`refuses ${conflict} conflict without any database writes`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kinan-demo-refusal-'));
    directories.push(directory);
    const env = envFor(directory);
    await seedDemo(env, { broker });
    const database = openDatabase(env.SQLITE_PATH!);
    database
      .query('DELETE FROM app_metadata WHERE key = ?')
      .run('demo_seed_v2');
    if (conflict === 'username')
      database
        .query('UPDATE users SET id = ? WHERE id = ?')
        .run('unrelated', DEMO_USER_ID);
    if (conflict === 'id')
      database
        .query('UPDATE users SET username = ? WHERE id = ?')
        .run('unrelated', DEMO_USER_ID);
    if (conflict === 'parameters')
      database.query('UPDATE devices SET parameters_json = ? WHERE id = ?').run(
        JSON.stringify({
          ...DEMO_PARAMETERS,
          custom: { id: 'custom', label: 'Custom', unit: '', points: 0 },
        }),
        DEMO_DEVICE_ID,
      );
    if (conflict === 'marker')
      database
        .query('INSERT INTO app_metadata VALUES (?, ?)')
        .run('demo_seed_v2', 'unrelated');
    const before = snapshot(database);
    await expect(seedDemo(env, { broker })).rejects.toThrow('Refusing');
    expect(snapshot(database)).toBe(before);
    database.close();
  });

test('adopts exact legacy demo without replacing its temperature ID or credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kinan-demo-legacy-'));
  directories.push(directory);
  const env = envFor(directory);
  await seedDemo(env, { broker });
  const database = openDatabase(env.SQLITE_PATH!);
  const repository = new Repository(database);
  database.query('DELETE FROM app_metadata WHERE key = ?').run('demo_seed_v2');
  repository.updateDevice(DEMO_DEVICE_ID, {
    parameters: { temperature: DEMO_PARAMETERS.temperature },
  });
  const secret = repository.getEncryptedSecret(DEMO_DEVICE_ID);
  await seedDemo(env, { broker });
  expect(repository.getDevice(DEMO_DEVICE_ID)!.parameters).toEqual(
    DEMO_PARAMETERS,
  );
  expect(repository.getEncryptedSecret(DEMO_DEVICE_ID)).toEqual(secret);
  database.close();
});

test('backup includes committed WAL data and uses private permissions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kinan-backup-'));
  directories.push(directory);
  const path = join(directory, 'kinan.sqlite');
  const database = openDatabase(path);
  database
    .query('INSERT INTO app_metadata VALUES (?, ?)')
    .run('wal-only', 'preserved');
  const backup = backupDatabase(path)!;
  expect(statSync(backup).mode & 0o777).toBe(0o600);
  const restored = new Database(backup, { readonly: true });
  expect(snapshot(restored)).toBe(snapshot(database));
  restored.close();
  database.close();
});
