import { beforeAll, describe, expect, test } from 'bun:test';
import { rmSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Database as SqliteDatabase } from 'bun:sqlite';
import * as XLSX from 'xlsx';
import { ExportStore } from './store';
import { ExportWorker } from './worker';
import type { ExporterConfig } from './config';
import type { ExportJobRecord } from './types';

const tmp = `${import.meta.dir}/.tmp-worker-test`;
const telemetryPath = `${tmp}/kinan.sqlite`;
const storePath = `${tmp}/exporter.sqlite`;
const filesDir = `${tmp}/exports`;

let worker: ExportWorker;
let store: ExportStore;
let deviceId: string;

const config: ExporterConfig = {
  EXPORTER_PORT: 0,
  EXPORTER_SQLITE_PATH: telemetryPath,
  EXPORTER_STORE_PATH: storePath,
  EXPORTER_FILES_DIR: filesDir,
  EXPORTER_PAGE_ROWS: 3,
  EXPORTER_MAX_ACTIVE_PER_USER: 5,
  EXPORTER_MAX_TOTAL_PER_USER_PER_DAY: 100,
  EXPORTER_RETENTION_MS: 7 * 24 * 60 * 60 * 1000,
  EXPORTER_MAX_ROWS: 100,
};

function seedTelemetry(count: number, sameTimestamp = false): void {
  const db = new SqliteDatabase(telemetryPath, { create: true });
  db.exec(
    `CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, label TEXT NOT NULL, active INTEGER NOT NULL, credential_version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, parameters_json TEXT NOT NULL, secret_iv TEXT NOT NULL, secret_ciphertext TEXT NOT NULL);`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS telemetry (device_id TEXT NOT NULL, write_id TEXT NOT NULL, timestamp INTEGER NOT NULL, credential_version INTEGER NOT NULL, values_json TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (device_id, write_id));`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS telemetry_latest (device_id TEXT PRIMARY KEY, write_id TEXT NOT NULL, timestamp INTEGER NOT NULL, credential_version INTEGER NOT NULL, values_json TEXT NOT NULL, received_at INTEGER NOT NULL);`,
  );
  db.query('DELETE FROM telemetry').run();
  db.query('DELETE FROM devices').run();
  const parametersJson = JSON.stringify({
    p1: { id: 'p1', label: 'Suhu', unit: 'C', points: 1, type: 'nilai' },
  });
  db.query(
    'INSERT INTO devices (id, owner_uid, label, active, credential_version, created_at, updated_at, parameters_json, secret_iv, secret_ciphertext) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'device_1',
    'user_1',
    'Demo device',
    1,
    1,
    0,
    0,
    parametersJson,
    'iv',
    'ct',
  );
  deviceId = 'device_1';
  const base = 1_000_000;
  for (let i = 0; i < count; i += 1) {
    const timestamp = sameTimestamp ? base : base + i;
    db.query(
      'INSERT INTO telemetry (device_id, write_id, timestamp, credential_version, values_json, received_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run(
      deviceId,
      `write-${i}`,
      timestamp,
      JSON.stringify({
        p1:
          i % 7 === 0
            ? { status: 'error', error: 'sensor err' }
            : { status: 'ok', value: i },
      }),
      timestamp,
    );
  }
  // The worker opens the database read-only, so flush the WAL first.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  console.log(
    'seedTelemetry devices before close:',
    JSON.stringify(db.query('SELECT id FROM devices').all()),
  );
  db.close();
}

function makeJob(): ExportJobRecord {
  return store.createJob(
    {
      userId: 'user_1',
      deviceId,
      parameterIds: ['p1'],
      start: 0,
      end: 2_000_000,
    },
    'Demo device',
  );
}

describe('export worker', () => {
  beforeAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(filesDir, { recursive: true });
    seedTelemetry(10);
    const rw = new SqliteDatabase(telemetryPath);
    console.log(
      'after seed, writable sees:',
      JSON.stringify(rw.query('SELECT id FROM devices').all()),
      'deviceId is:',
      deviceId,
    );
    rw.close();
    store = new ExportStore(storePath);
    worker = new ExportWorker(store, config);
  });

  test('exports all rows across keyset pages in chronological order', async () => {
    const job = makeJob();
    const result = await worker.runExport(job);
    expect(result.rowCount).toBe(10);
    expect(existsSync(join(filesDir, result.filePath))).toBe(true);
    const workbook = XLSX.readFile(join(filesDir, result.filePath));
    const sheet = XLSX.utils.sheet_to_json<Record<string, string | number>>(
      workbook.Sheets['Data']!,
    );
    expect(sheet).toHaveLength(10);
    // Rows must be ascending by timestamp; every 7th sample is an error cell.
    const values = sheet.map((row) => row['Suhu (C)']);
    expect(values[1]).toBe(1);
    expect(values[7]).toBe('');
    expect(values[9]).toBe(9);
  });

  test('handles identical timestamps with write_id tiebreak', async () => {
    seedTelemetry(5, true);
    const secondStore = new ExportStore(`${tmp}/store2.sqlite`);
    const secondWorker = new ExportWorker(secondStore, {
      ...config,
      EXPORTER_PAGE_ROWS: 2,
    });
    const job = secondStore.createJob(
      {
        userId: 'user_1',
        deviceId,
        parameterIds: ['p1'],
        start: 0,
        end: 2_000_000,
      },
      'Demo device',
    );
    const result = await secondWorker.runExport(job);
    expect(result.rowCount).toBe(5);
    secondStore.close();
  });

  test('rejects jobs for devices owned by another user', async () => {
    seedTelemetry(10);
    const job = store.createJob(
      {
        userId: 'user_2',
        deviceId,
        parameterIds: ['p1'],
        start: 0,
        end: 2_000_000,
      },
      'Demo device',
    );
    await expect(worker.runExport(job)).rejects.toThrow(/tidak dimiliki/);
    const owned = store.createJob(
      {
        userId: 'user_1',
        deviceId: 'missing_device',
        parameterIds: ['p1'],
        start: 0,
        end: 2_000_000,
      },
      'Demo device',
    );
    await expect(worker.runExport(owned)).rejects.toThrow(/tidak ditemukan/);
  });

  test('enforces the maximum row guard', async () => {
    seedTelemetry(10);
    const limitedStore = new ExportStore(`${tmp}/store3.sqlite`);
    const limitedWorker = new ExportWorker(limitedStore, {
      ...config,
      EXPORTER_MAX_ROWS: 5,
    });
    const job = limitedStore.createJob(
      {
        userId: 'user_1',
        deviceId,
        parameterIds: ['p1'],
        start: 0,
        end: 2_000_000,
      },
      'Demo device',
    );
    await expect(limitedWorker.runExport(job)).rejects.toThrow(
      /batas maksimum/,
    );
    limitedStore.close();
  });

  test('prunes finished files after retention', async () => {
    seedTelemetry(10);
    const job = makeJob();
    const result = await worker.runExport(job);
    const filePath = join(filesDir, result.filePath);
    expect(existsSync(filePath)).toBe(true);
    const size = statSync(filePath).size;
    expect(size).toBeGreaterThan(0);
    store.update(job.id, {
      status: 'ready',
      filePath: result.filePath,
      fileBytes: result.fileBytes,
      rowCount: result.rowCount,
      finishedAt: Date.now(),
    });
    const removed = store.pruneBefore(Date.now() + 60_000);
    expect(removed).toContain(result.filePath);
    rmSync(filePath, { force: true });
    expect(existsSync(filePath)).toBe(false);
  });
});
