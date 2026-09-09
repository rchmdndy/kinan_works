import { Database as SqliteDatabase } from 'bun:sqlite';
import { MosquittoFileCredentials } from './broker.js';
import { loadConfig } from './config.js';
import { encryptSecret, generateDeviceSecret } from './crypto.js';
import {
  backupDatabase,
  openDatabase,
  parameterMap,
  Repository,
} from './repository.js';
import type { Device, LocalUser } from './types.js';

export const DEMO_USERNAME = 'test@skripsi.com';
export const DEMO_PASSWORD = 'loginlogin';
export const DEMO_USER_ID = 'demo-user-v1';
export const DEMO_DEVICE_ID = 'demo-device-01';
const DEMO_DISPLAY_NAME = 'Demo Administrator';
const DEMO_DEVICE_LABEL = 'Demo device';
const LEGACY_DEMO_USERNAMES = ['demo'];

export type DemoSeedResult = {
  users: number;
  devices: number;
  telemetry: number;
  createdUser: boolean;
  createdDevice: boolean;
};

function removeLegacyDemoUsers(repository: Repository): void {
  for (const username of LEGACY_DEMO_USERNAMES) {
    const legacy = repository.getUserByUsername(username);
    if (!legacy) continue;
    for (const device of repository.listAllDevices()) {
      if (device.ownerUid === legacy.id) repository.deleteDevice(device.id);
    }
    repository.deleteUser(legacy.id);
  }
}

function demoDevice(now: number, ownerUid: string): Device {
  return {
    id: DEMO_DEVICE_ID,
    ownerUid,
    label: DEMO_DEVICE_LABEL,
    active: true,
    credentialVersion: 1,
    createdAt: now,
    updatedAt: now,
    parameters: parameterMap([
      { id: 'temperature', label: 'Temperature', unit: '°C', points: 1 },
    ]),
  };
}

function assertDeviceIdentity(existing: Device, expected: Device): void {
  if (
    existing.ownerUid !== expected.ownerUid ||
    existing.label !== expected.label ||
    existing.credentialVersion !== expected.credentialVersion ||
    JSON.stringify(existing.parameters) !== JSON.stringify(expected.parameters)
  )
    throw new Error(
      `Refusing to overwrite conflicting device ${DEMO_DEVICE_ID}; choose another seed identity.`,
    );
}

function readonlyCounts(
  path: string,
): Omit<DemoSeedResult, 'createdUser' | 'createdDevice'> {
  const database = new SqliteDatabase(path, { readonly: true, strict: true });
  try {
    const count = (table: 'users' | 'devices' | 'telemetry') =>
      (
        database.query(`SELECT count(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count;
    return {
      users: count('users'),
      devices: count('devices'),
      telemetry: count('telemetry'),
    };
  } finally {
    database.close();
  }
}

export async function seedDemo(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    dryRun?: boolean;
    password?: string;
    broker?: { sync(): Promise<void> };
  } = {},
): Promise<DemoSeedResult> {
  const config = loadConfig(env);
  if (config.NODE_ENV !== 'development')
    throw new Error('Demo seeding is allowed only when NODE_ENV=development');
  if (options.dryRun) {
    const counts = readonlyCounts(config.SQLITE_PATH);
    return {
      ...counts,
      createdUser: false,
      createdDevice: false,
    };
  }

  // Always preserve a recoverable snapshot before touching an existing database.
  backupDatabase(config.SQLITE_PATH);
  const database = openDatabase(config.SQLITE_PATH, { backup: false });
  const repository = new Repository(database);
  try {
    const now = Date.now();
    removeLegacyDemoUsers(repository);
    let user = repository.getUserByUsername(DEMO_USERNAME);
    let createdUser = false;
    if (!user) {
      const password = options.password || DEMO_PASSWORD;
      if (password.length < 8)
        throw new Error('Demo password must contain at least 8 characters');
      const localUser: LocalUser = {
        id: DEMO_USER_ID,
        username: DEMO_USERNAME,
        displayName: DEMO_DISPLAY_NAME,
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      repository.createUser(
        localUser,
        await Bun.password.hash(password, 'argon2id'),
      );
      user = repository.getUserByUsername(DEMO_USERNAME)!;
      createdUser = true;
    }

    const expectedDevice = demoDevice(now, user.id);
    const existing = repository.getDevice(DEMO_DEVICE_ID);
    let createdDevice = false;
    if (existing) assertDeviceIdentity(existing, expectedDevice);
    else {
      repository.saveDeviceBundle(
        expectedDevice,
        await encryptSecret(generateDeviceSecret(), config.encryptionKey),
      );
      createdDevice = true;
    }
    await (
      options.broker ?? new MosquittoFileCredentials(repository, config)
    ).sync();
    return {
      users: repository.countUsers(),
      devices: repository.listAllDevices().length,
      telemetry: repository.getHistory(
        DEMO_DEVICE_ID,
        0,
        Date.now() + 1,
        1_000_000,
      ).length,
      createdUser,
      createdDevice,
    };
  } finally {
    repository.close();
  }
}
