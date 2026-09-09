import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_DEVICE_ID, seedDemo } from '../src/demo-seed.js';
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
});
