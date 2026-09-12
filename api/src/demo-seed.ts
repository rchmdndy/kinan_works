import { Database as SqliteDatabase } from 'bun:sqlite';
import { existsSync } from 'node:fs';
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
const OWNERSHIP_KEY = 'demo_seed_v2';
const OWNERSHIP_VALUE = JSON.stringify({
  user: DEMO_USER_ID,
  device: DEMO_DEVICE_ID,
});
const legacyParameters = parameterMap([
  {
    id: 'temperature',
    label: 'Temperature',
    unit: '°C',
    points: 1,
    type: 'nilai',
  },
]);
export const DEMO_PARAMETERS = parameterMap([
  ...Object.values(legacyParameters),
  {
    id: 'demo_state',
    label: 'Demo switch',
    unit: '',
    points: 0,
    type: 'control-state',
  },
  {
    id: 'demo_setpoint',
    label: 'Demo setpoint',
    unit: '°C',
    points: 1,
    type: 'control-setpoint',
    min: 0,
    max: 100,
  },
]);

export type DemoSeedResult = {
  users: number;
  devices: number;
  telemetry: number;
  createdUser: boolean;
  createdDevice: boolean;
};

function assertOwnership(
  database: SqliteDatabase,
  repository: Repository,
): void {
  const user = repository.getUserById(DEMO_USER_ID);
  const namedUser = repository.getUserByUsername(DEMO_USERNAME);
  if (
    (user && user.username !== DEMO_USERNAME) ||
    (namedUser && namedUser.id !== DEMO_USER_ID)
  )
    throw new Error('Refusing to overwrite conflicting demo user identity');
  const marker = database
    .query('SELECT value FROM app_metadata WHERE key = ?')
    .get(OWNERSHIP_KEY) as { value: string } | null;
  if (marker && marker.value !== OWNERSHIP_VALUE)
    throw new Error('Refusing to overwrite conflicting demo ownership marker');
  const device = repository.getDevice(DEMO_DEVICE_ID);
  if (device && (!user || device.ownerUid !== DEMO_USER_ID))
    throw new Error(
      `Refusing to overwrite conflicting device ${DEMO_DEVICE_ID}`,
    );
  // Adopt only the exact legacy seed fingerprint. IDs or a username alone are
  // not provenance. Once adopted, the marker owns only the three fixed params.
  if (
    !marker &&
    ((user && user.displayName !== DEMO_DISPLAY_NAME) ||
      (device &&
        (device.label !== DEMO_DEVICE_LABEL ||
          device.credentialVersion !== 1 ||
          JSON.stringify(device.parameters) !==
            JSON.stringify(legacyParameters))))
  )
    throw new Error(
      `Refusing to overwrite conflicting device or unproven demo identity ${DEMO_DEVICE_ID}`,
    );
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
  if (
    config.NODE_ENV !== 'development' &&
    env.ALLOW_DEMO_SEED_IN_PRODUCTION !== '1'
  )
    throw new Error(
      'Demo seeding requires NODE_ENV=development or explicit ALLOW_DEMO_SEED_IN_PRODUCTION=1',
    );
  // Never run application-wide migrations as a side effect of demo refresh.
  const existed = existsSync(config.SQLITE_PATH);
  if (!existed && options.dryRun)
    throw new Error('Demo database does not exist');
  if (!existed) openDatabase(config.SQLITE_PATH, { backup: false }).close();
  const database = new SqliteDatabase(config.SQLITE_PATH, {
    readonly: true,
    strict: true,
  });
  try {
    assertOwnership(database, new Repository(database));
    if (options.dryRun) return counts(database, false, false);
  } finally {
    database.close();
  }
  const password = options.password || DEMO_PASSWORD;
  if (password.length < 8)
    throw new Error('Demo password must contain at least 8 characters');
  const passwordHash = await Bun.password.hash(password, 'argon2id');
  const secret = await encryptSecret(
    generateDeviceSecret(),
    config.encryptionKey,
  );
  backupDatabase(config.SQLITE_PATH);
  const writable = openDatabase(config.SQLITE_PATH, {
    backup: false,
    migrate: false,
  });
  const repository = new Repository(writable);
  try {
    const result = writable
      .transaction(() => {
        // Recheck under the write lock, before the first write; conflicts are atomic.
        assertOwnership(writable, repository);
        const now = Date.now();
        const user = repository.getUserById(DEMO_USER_ID);
        const device = repository.getDevice(DEMO_DEVICE_ID);
        if (!user) {
          const localUser: LocalUser = {
            id: DEMO_USER_ID,
            username: DEMO_USERNAME,
            displayName: DEMO_DISPLAY_NAME,
            active: true,
            createdAt: now,
            updatedAt: now,
          };
          repository.createUser(localUser, passwordHash);
        }
        // Existing passwords, sessions, ownership, credential versions and secrets
        // remain intact. No history or unrelated parameters are deleted.
        if (!device) {
          const demo: Device = {
            id: DEMO_DEVICE_ID,
            ownerUid: DEMO_USER_ID,
            label: DEMO_DEVICE_LABEL,
            active: true,
            credentialVersion: 1,
            createdAt: now,
            updatedAt: now,
            parameters: DEMO_PARAMETERS,
          };
          repository.saveDeviceBundle(demo, secret);
        } else {
          const parameters = { ...device.parameters, ...DEMO_PARAMETERS };
          if (
            JSON.stringify(device.parameters) !== JSON.stringify(parameters) ||
            device.label !== DEMO_DEVICE_LABEL ||
            !device.active
          )
            repository.updateDevice(DEMO_DEVICE_ID, {
              parameters,
              label: DEMO_DEVICE_LABEL,
              active: true,
              updatedAt: now,
            });
        }
        writable
          .query(
            'INSERT INTO app_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
          )
          .run(OWNERSHIP_KEY, OWNERSHIP_VALUE);
        return counts(writable, !user, !device);
      })
      .immediate();
    await (
      options.broker ?? new MosquittoFileCredentials(repository, config)
    ).sync();
    return result;
  } finally {
    repository.close();
  }
}

function counts(
  database: SqliteDatabase,
  createdUser: boolean,
  createdDevice: boolean,
): DemoSeedResult {
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
    createdUser,
    createdDevice,
  };
}
