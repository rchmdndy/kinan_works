import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { Database as SqliteDatabase } from 'bun:sqlite';
import { ExportStore } from './store';
import { ExportWorker } from './worker';
import { createExporterRoutes } from './service';
import type { ExporterConfig } from './config';

const tmp = `${import.meta.dir}/.tmp-service-test`;
const telemetryPath = `${tmp}/kinan.sqlite`;
const storePath = `${tmp}/exporter.sqlite`;
const filesDir = `${tmp}/exports`;

const config: ExporterConfig = {
  EXPORTER_PORT: 0,
  EXPORTER_SQLITE_PATH: telemetryPath,
  EXPORTER_STORE_PATH: storePath,
  EXPORTER_FILES_DIR: filesDir,
  EXPORTER_PAGE_ROWS: 3,
  EXPORTER_MAX_ACTIVE_PER_USER: 2,
  EXPORTER_MAX_TOTAL_PER_USER_PER_DAY: 100,
  EXPORTER_RETENTION_MS: 7 * 24 * 60 * 60 * 1000,
  EXPORTER_MAX_ROWS: 100,
};

let store: ExportStore;
let app: ReturnType<typeof createExporterRoutes>;

function seed(): void {
  const db = new SqliteDatabase(telemetryPath, { create: true });
  db.exec(
    'CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, label TEXT NOT NULL, active INTEGER NOT NULL, credential_version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, parameters_json TEXT NOT NULL, secret_iv TEXT NOT NULL, secret_ciphertext TEXT NOT NULL)',
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS telemetry (device_id TEXT NOT NULL, write_id TEXT NOT NULL, timestamp INTEGER NOT NULL, credential_version INTEGER NOT NULL, values_json TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (device_id, write_id))',
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
  for (let i = 0; i < 4; i += 1) {
    db.query(
      'INSERT INTO telemetry (device_id, write_id, timestamp, credential_version, values_json, received_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run(
      'device_1',
      `write-${i}`,
      1_000_000 + i,
      JSON.stringify({ p1: { status: 'ok', value: i } }),
      1_000_000 + i,
    );
  }
  db.close();
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await app.handle(
    new Request(`http://localhost${path}`, init),
  );
  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { status: response.status, json };
}

describe('exporter internal service', () => {
  beforeAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(filesDir, { recursive: true });
    seed();
    store = new ExportStore(storePath);
    app = createExporterRoutes(store, config);
  });
  afterAll(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('health responds ok', async () => {
    const result = await call('GET', '/internal/exports/health');
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
  });

  test('rejects invalid job payloads', async () => {
    const result = await call('POST', '/internal/exports/', {
      userId: 'user_1',
      deviceId: 'device_1',
      parameterIds: [],
      start: 10,
      end: 20,
    });
    expect(result.status).toBe(400);
  });

  test('rejects reversed ranges', async () => {
    const result = await call('POST', '/internal/exports/', {
      userId: 'user_1',
      deviceId: 'device_1',
      parameterIds: ['p1'],
      start: 20,
      end: 10,
    });
    expect(result.status).toBe(400);
  });

  test('creates jobs and enforces active limits', async () => {
    const first = await call('POST', '/internal/exports/', {
      userId: 'user_1',
      deviceId: 'device_1',
      parameterIds: ['p1'],
      start: 0,
      end: 2_000_000,
    });
    expect(first.status).toBe(200);
    const second = await call('POST', '/internal/exports/', {
      userId: 'user_1',
      deviceId: 'device_1',
      parameterIds: ['p1'],
      start: 0,
      end: 2_000_000,
    });
    expect(second.status).toBe(200);
    const third = await call('POST', '/internal/exports/', {
      userId: 'user_1',
      deviceId: 'device_1',
      parameterIds: ['p1'],
      start: 0,
      end: 2_000_000,
    });
    expect(third.status).toBe(429);
  });

  test('lists jobs per user only', async () => {
    const mine = await call('GET', '/internal/exports/?userId=user_1&limit=10');
    expect(mine.status).toBe(200);
    const mineJobs = mine.json.exports as Array<{ id: string }>;
    expect(mineJobs.length).toBe(2);
    const other = await call(
      'GET',
      '/internal/exports/?userId=user_2&limit=10',
    );
    expect(other.json.exports).toHaveLength(0);
  });

  test('serves ready files and hides other users', async () => {
    const job = store.createJob(
      {
        userId: 'user_1',
        deviceId: 'device_1',
        parameterIds: ['p1'],
        start: 0,
        end: 2_000_000,
      },
      'Demo device',
    );
    const worker = new ExportWorker(store, config);
    const result = await worker.runExport(job);
    store.update(job.id, {
      status: 'ready',
      filePath: result.filePath,
      fileBytes: result.fileBytes,
      rowCount: result.rowCount,
      finishedAt: Date.now(),
    });
    const owner = await call(
      'GET',
      `/internal/exports/${job.id}?userId=user_1`,
    );
    expect(owner.status).toBe(200);
    const ownerJob = owner.json.job as { status: string; rowCount: number };
    expect(ownerJob.status).toBe('ready');
    expect(ownerJob.rowCount).toBe(4);
    const stranger = await call(
      'GET',
      `/internal/exports/${job.id}?userId=user_2`,
    );
    expect(stranger.status).toBe(404);

    const response = await app.handle(
      new Request(
        `http://localhost/internal/exports/${job.id}/file?userId=user_1`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const notReady = await app.handle(
      new Request(
        `http://localhost/internal/exports/${job.id}/file?userId=user_2`,
      ),
    );
    expect(notReady.status).toBe(404);
  });

  test('missing job returns 404', async () => {
    const result = await call(
      'GET',
      '/internal/exports/does-not-exist?userId=user_1',
    );
    expect(result.status).toBe(404);
  });
});
