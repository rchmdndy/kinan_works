import { cert, getApps, getApp, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { loadConfig, loadServiceAccount } from '../api/src/config.js';
import { assertMetadataMigrated, listMetadataDeviceIds, openMetadataDatabase } from '../api/src/repository.js';

const config = loadConfig();
const dryRun = !process.argv.includes('--apply');
const deviceId = process.argv.find((value) => value.startsWith('--device='))?.slice('--device='.length);
const account = loadServiceAccount(config.FIREBASE_SERVICE_ACCOUNT_PATH);
const app = getApps()[0] ?? initializeApp({ credential: cert(account), databaseURL: config.FIREBASE_DATABASE_URL });
const db = getDatabase(app);
const sqlite = openMetadataDatabase(config.SQLITE_PATH);
assertMetadataMigrated(sqlite);
const deviceIds = deviceId ? [deviceId] : listMetadataDeviceIds(sqlite);
sqlite.close();
const cutoff = Date.now() - config.RETENTION_DAYS * 24 * 60 * 60 * 1000;
const targets: Array<{ ref: ReturnType<ReturnType<typeof db.ref>['child']>; path: string }> = [];

for (const id of deviceIds) {
  const history = db.ref(`telemetry/${id}/history`);
  const snapshot = await history.orderByChild('timestamp').endAt(cutoff - 1).get();
  if (snapshot.exists()) {
    for (const sampleId of Object.keys(snapshot.val() as Record<string, unknown>)) {
      targets.push({ ref: history.child(sampleId), path: `telemetry/${id}/history/${sampleId}` });
    }
  }
}

console.log(JSON.stringify({ dryRun, cutoff, devices: deviceIds.length, count: targets.length, paths: targets.map((target) => target.path) }, null, 2));
if (!dryRun) await Promise.all(targets.map((target) => target.ref.remove()));
