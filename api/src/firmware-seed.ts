import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { encryptSecret, generateDeviceSecret } from './crypto.js';
import { backupDatabase, openDatabase, Repository } from './repository.js';
import { MosquittoFileCredentials } from './broker.js';
import {
  FIRMWARE_DEVICE_ID,
  FIRMWARE_MARKER,
  FIRMWARE_PARAMETERS,
} from './firmware-profile.js';
import { DEMO_USER_ID } from './demo-seed.js';

export async function seedFirmware(
  env = process.env,
  broker?: { sync(): Promise<void> },
) {
  const config = loadConfig(env);
  const ownerUid = env.FIRMWARE_OWNER_ID ?? DEMO_USER_ID;
  if (!existsSync(config.SQLITE_PATH))
    throw new Error('Initialize the application database first');
  // Existing initialized DB only: never run migrations or broad demo seeding here.
  const db = openDatabase(config.SQLITE_PATH, {
    migrate: false,
    backup: false,
  });
  const repository = new Repository(db);
  try {
    if (!repository.getUserById(ownerUid)?.active)
      throw new Error('Firmware owner must be an active existing account');
    const secret = await encryptSecret(
      generateDeviceSecret(),
      config.encryptionKey,
    );
    backupDatabase(config.SQLITE_PATH);
    const created = db
      .transaction(() => {
        const device = repository.getDevice(FIRMWARE_DEVICE_ID);
        const marker = db
          .query('SELECT value FROM app_metadata WHERE key = ?')
          .get(FIRMWARE_MARKER) as { value: string } | null;
        const identity = JSON.stringify({
          deviceId: FIRMWARE_DEVICE_ID,
          ownerUid,
        });
        if (marker && marker.value !== identity)
          throw new Error('Conflicting firmware ownership marker');
        if (device) {
          if (!marker || device.ownerUid !== ownerUid)
            throw new Error(
              'Refusing to adopt or overwrite existing firmware device',
            );
          return false; // Preserve edits, secrets, history and credential versions on rerun.
        }
        const now = Date.now();
        repository.saveDeviceBundle(
          {
            id: FIRMWARE_DEVICE_ID,
            ownerUid,
            label: 'Grow Sense Growth Chamber',
            active: true,
            credentialVersion: 1,
            createdAt: now,
            updatedAt: now,
            parameters: FIRMWARE_PARAMETERS,
          },
          secret,
        );
        db.query(
          'INSERT INTO app_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
        ).run(FIRMWARE_MARKER, identity);
        return true;
      })
      .immediate();
    await (broker ?? new MosquittoFileCredentials(repository, config)).sync();
    return { deviceId: FIRMWARE_DEVICE_ID, created };
  } finally {
    repository.close();
  }
}
if (import.meta.main) {
  console.log(JSON.stringify(await seedFirmware()));
}
