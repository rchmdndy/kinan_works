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
  db.exec(
    `CREATE TABLE IF NOT EXISTS device_commands (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, packet_json TEXT NOT NULL);`,
  );
  db.query('DELETE FROM telemetry').run();
  db.query('DELETE FROM device_commands').run();
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

function seedSetpointCommands(): void {
  const db = new SqliteDatabase(telemetryPath);
  const parameters = JSON.stringify({
    p1: { id: 'p1', label: 'Suhu', unit: 'C', points: 1, type: 'nilai' },
    target_a: {
      id: 'target_a',
      label: 'Target A',
      unit: '°C',
      points: 1,
      type: 'control-setpoint',
      min: 0,
      max: 100,
    },
    target_b: {
      id: 'target_b',
      label: 'Target B',
      unit: '%',
      points: 0,
      type: 'control-setpoint',
      min: 0,
      max: 100,
    },
    switch_1: {
      id: 'switch_1',
      label: 'Saklar',
      unit: '',
      points: 0,
      type: 'control-state',
    },
  });
  db.query('UPDATE devices SET parameters_json = ? WHERE id = ?').run(
    parameters,
    deviceId,
  );
  const insert = db.query(
    'INSERT INTO device_commands(id, device_id, expires_at, status, packet_json) VALUES (?, ?, ?, ?, ?)',
  );
  const command = (
    id: string,
    parameterId: string,
    timestamp: number,
    status: string,
    value: number | boolean,
    resultTimestamp?: number,
    reason?: string,
    sourceDevice = deviceId,
  ) =>
    insert.run(
      id,
      sourceDevice,
      timestamp + 10_000,
      status,
      JSON.stringify({
        commandId: id,
        deviceId: sourceDevice,
        parameterId,
        timestamp,
        expiresAt: timestamp + 10_000,
        revision: 0,
        credentialVersion: 1,
        connectionId: '11111111-1111-4111-8111-111111111111',
        value,
        status,
        ...(reason ? { reason } : {}),
        ...(resultTimestamp
          ? {
              result: {
                commandId: id,
                timestamp: resultTimestamp,
                credentialVersion: 1,
                connectionId: '11111111-1111-4111-8111-111111111111',
                status: status === 'succeeded' ? 'succeeded' : 'rejected',
                ...(reason ? { reason } : {}),
              },
            }
          : {}),
      }),
    );
  command('a-old', 'target_a', 1_000_900, 'succeeded', 10, 1_000_905);
  command('a-newer-old', 'target_a', 1_000_950, 'succeeded', 11, 1_000_955);
  command('b-old', 'target_b', 1_000_925, 'succeeded', 20, 1_000_930);
  command('at-start', 'target_a', 1_001_000, 'pending', 12);
  command('success-temp', 'target_a', 1_001_025, 'succeeded', 20, 1_001_026);
  command('success-rh', 'target_b', 1_001_025, 'succeeded', 50, 1_001_027);
  command(
    'rejected',
    'target_b',
    1_001_100,
    'rejected',
    21,
    1_001_120,
    'interlock',
  );
  command(
    'unknown',
    'target_a',
    1_001_200,
    'unknown',
    13,
    undefined,
    'timeout',
  );
  command('at-end', 'target_a', 1_002_000, 'succeeded', 14, 1_002_005);
  command('switch', 'switch_1', 1_001_150, 'succeeded', true, 1_001_155);
  command(
    'other-device',
    'target_a',
    1_001_150,
    'succeeded',
    30,
    1_001_155,
    undefined,
    'device_2',
  );
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
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
    expect(workbook.SheetNames).toEqual(['Data', 'Informasi']);
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

  test('writes full setpoint command history with explicit pre-period context', async () => {
    seedTelemetry(55);
    seedSetpointCommands();
    const setpointStore = new ExportStore(`${tmp}/setpoint.sqlite`);
    const setpointWorker = new ExportWorker(setpointStore, {
      ...config,
      EXPORTER_PAGE_ROWS: 2,
    });
    const job = setpointStore.createJob(
      {
        userId: 'user_1',
        deviceId,
        parameterIds: ['p1'],
        start: 1_001_000,
        end: 1_002_000,
      },
      'Demo device',
    );
    const result = await setpointWorker.runExport(job);
    expect(result.rowCount).toBe(0);
    const workbook = XLSX.readFile(join(filesDir, result.filePath), {
      cellDates: true,
    });
    expect(workbook.SheetNames).toEqual([
      'Data',
      'Informasi',
      'Riwayat Setpoint',
    ]);
    const rows = XLSX.utils
      .sheet_to_json<
        Record<string, string | number>
      >(workbook.Sheets['Riwayat Setpoint']!)
      .filter((row) => typeof row.commandId === 'string');
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.commandId)).toEqual([
      'b-old',
      'a-newer-old',
      'at-start',
      'success-rh',
      'success-temp',
      'rejected',
      'unknown',
    ]);
    expect(rows[0]!['penanda konteks']).toContain('Konteks sebelum periode');
    expect(rows[1]!['target']).toBe(11);
    expect(rows[2]!['status perintah']).toBe('pending');
    expect(rows[3]!['status perintah']).toBe('succeeded');
    expect(rows[4]!['status perintah']).toBe('succeeded');
    expect(rows[2]!['penanda konteks']).toBe(
      'Dalam periode [1970-01-01T00:16:41Z, 1970-01-01T00:16:42Z) UTC (mulai inklusif, akhir eksklusif).',
    );
    expect(rows[5]!['alasan']).toBe('interlock');
    expect(rows[6]!['alasan']).toBe('timeout');
    const dataRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(
      workbook.Sheets['Data']!,
      { defval: '' },
    );
    expect(Object.keys(dataRows[0]!)).toEqual([
      'timestamp',
      'Suhu (C)',
      'Set Point Target A (°C)',
      'Set Point Target B (%)',
    ]);
    const sparseSetpoints = dataRows.filter(
      (row) =>
        row['Set Point Target A (°C)'] !== '' ||
        row['Set Point Target B (%)'] !== '',
    );
    expect(sparseSetpoints).toHaveLength(2);
    expect(
      sparseSetpoints.map((row) => row['Set Point Target A (°C)']),
    ).toEqual(['', 20]);
    expect(sparseSetpoints.map((row) => row['Set Point Target B (%)'])).toEqual(
      [50, ''],
    );
    expect(sparseSetpoints.every((row) => row['Suhu (C)'] === '')).toBe(true);
    expect(dataRows.some((row) => row['Set Point Target A (°C)'] === 12)).toBe(
      false,
    );
    expect(dataRows.some((row) => row['Set Point Target B (%)'] === 21)).toBe(
      false,
    );
    expect(rows.every((row) => row.commandId !== 'at-end')).toBe(true);
    expect(rows.every((row) => row.commandId !== 'switch')).toBe(true);
    expect(rows.every((row) => row.commandId !== 'other-device')).toBe(true);
    setpointStore.close();
  });

  test('writes an explained empty setpoint history sheet', async () => {
    seedTelemetry(1);
    seedSetpointCommands();
    const db = new SqliteDatabase(telemetryPath);
    db.query('DELETE FROM device_commands').run();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.close();
    const emptyStore = new ExportStore(`${tmp}/empty-setpoint.sqlite`);
    const emptyWorker = new ExportWorker(emptyStore, config);
    const job = emptyStore.createJob(
      {
        userId: 'user_1',
        deviceId,
        parameterIds: ['p1'],
        start: 3_000_000,
        end: 3_000_001,
      },
      'Demo device',
    );
    const result = await emptyWorker.runExport(job);
    const workbook = XLSX.readFile(join(filesDir, result.filePath));
    const sheet = workbook.Sheets['Riwayat Setpoint']!;
    expect(sheet.A1?.v).toBe('waktu dikirim');
    expect(String(sheet.A2?.v)).toBe(
      'Tidak ada riwayat perintah setpoint untuk rentang [1970-01-01T00:50:00Z, 1970-01-01T00:50:00.001Z) UTC (mulai inklusif, akhir eksklusif). Riwayat mencakup perintah yang dikirim dalam rentang tersebut serta konteks terakhir yang berhasil sebelum 1970-01-01T00:50:00Z UTC bila tersedia.',
    );
    expect(String(sheet.A4?.v)).toContain(
      'Rentang laporan adalah [1970-01-01T00:50:00Z, 1970-01-01T00:50:00.001Z) UTC (mulai inklusif, akhir eksklusif).',
    );
    expect(String(sheet.A2?.v)).not.toContain('[mulai, akhir)');
    expect(String(sheet.A4?.v)).not.toContain('[mulai, akhir)');
    emptyStore.close();
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
