import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { loadConfig, loadServiceAccount } from './config.js';
import { decryptSecret } from './crypto.js';
import { importMetadata, metadataCounts, openMetadataDatabase, type MetadataImport } from './repository.js';
import type { Device, DeviceAccess, EncryptedSecret } from './types.js';

const config = loadConfig();
const allowEmpty = process.argv.includes('--allow-empty');
const verifyOnly = process.argv.includes('--verify-only');
const sqlitePath = config.SQLITE_PATH;
mkdirSync(dirname(sqlitePath), { recursive: true });

let backupPath: string | null = null;
if (!verifyOnly && existsSync(sqlitePath)) {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  backupPath = `${sqlitePath}.backup-${timestamp}`;
  const source = openMetadataDatabase(sqlitePath);
  writeFileSync(backupPath, source.serialize());
  chmodSync(backupPath, 0o600);
  source.close();
}

const account = loadServiceAccount(config.FIREBASE_SERVICE_ACCOUNT_PATH);
const app = initializeApp({ credential: cert(account), databaseURL: config.FIREBASE_DATABASE_URL }, `sqlite-migration-${crypto.randomUUID()}`);
try {
  const snapshot = await getDatabase(app).ref().get();
  const root = (snapshot.exists() ? snapshot.val() : {}) as Record<string, unknown>;
  const backend = (root.backend ?? {}) as Record<string, unknown>;
  const input: MetadataImport = {
    devices: (root.devices ?? {}) as Record<string, Device>,
    access: (backend.deviceAccess ?? {}) as Record<string, DeviceAccess>,
    secrets: (backend.deviceSecrets ?? {}) as Record<string, EncryptedSecret>
  };
  const cloudCounts = {
    devices: Object.keys(input.devices).length,
    access: Object.keys(input.access).length,
    secrets: Object.keys(input.secrets).length
  };
  for (const encrypted of Object.values(input.secrets)) await decryptSecret(encrypted, config.encryptionKey);
  if (verifyOnly) {
    if (!existsSync(sqlitePath)) throw new Error(`SQLite database does not exist at ${sqlitePath}`);
    const sqlite = openMetadataDatabase(sqlitePath);
    const localCounts = metadataCounts(sqlite);
    sqlite.close();
    if (localCounts.devices !== cloudCounts.devices || localCounts.secrets !== cloudCounts.secrets || cloudCounts.devices !== cloudCounts.access) {
      throw new Error(`Count verification failed: cloud devices/access/secrets=${cloudCounts.devices}/${cloudCounts.access}/${cloudCounts.secrets}, SQLite devices/secrets=${localCounts.devices}/${localCounts.secrets}`);
    }
    console.log(JSON.stringify({ verified: true, sqlitePath, cloud: cloudCounts, sqlite: localCounts }));
  } else {
    const sqlite = openMetadataDatabase(sqlitePath);
    const imported = importMetadata(sqlite, input, allowEmpty);
    const localCounts = metadataCounts(sqlite);
    sqlite.close();
    console.log(JSON.stringify({ migrated: true, sqlitePath, backupPath, cloud: cloudCounts, imported, sqlite: localCounts }));
  }
} finally {
  await deleteApp(app);
}
