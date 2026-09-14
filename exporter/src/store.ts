import { Database as SqliteDatabase } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CreateExportJob, ExportJobRecord, ExportSummary } from './types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_label TEXT NOT NULL,
  parameter_ids_json TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  row_count INTEGER,
  error TEXT,
  file_path TEXT,
  file_bytes INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS exports_user_created ON exports(user_id, created_at DESC);
`;

function rowToRecord(row: ExportRow): ExportJobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    deviceLabel: row.device_label,
    parameterIds: JSON.parse(row.parameter_ids_json) as string[],
    start: row.start_ts,
    end: row.end_ts,
    status: row.status as ExportJobRecord['status'],
    rowCount: row.row_count,
    error: row.error,
    filePath: row.file_path,
    fileBytes: row.file_bytes,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

type ExportRow = {
  id: string;
  user_id: string;
  device_id: string;
  device_label: string;
  parameter_ids_json: string;
  start_ts: number;
  end_ts: number;
  status: string;
  row_count: number | null;
  error: string | null;
  file_path: string | null;
  file_bytes: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

export class ExportStore {
  private readonly db: SqliteDatabase;
  constructor(readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new SqliteDatabase(databasePath, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
  }

  createJob(input: CreateExportJob, deviceLabel: string): ExportJobRecord {
    const record: ExportJobRecord = {
      id: crypto.randomUUID(),
      userId: input.userId,
      deviceId: input.deviceId,
      deviceLabel,
      parameterIds: input.parameterIds,
      start: input.start,
      end: input.end,
      status: 'queued',
      rowCount: null,
      error: null,
      filePath: null,
      fileBytes: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.insert(record);
    return record;
  }

  insert(record: ExportJobRecord): void {
    this.db
      .query(
        `INSERT INTO exports (id, user_id, device_id, device_label, parameter_ids_json, start_ts, end_ts, status, row_count, error, file_path, file_bytes, created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.userId,
        record.deviceId,
        record.deviceLabel,
        JSON.stringify(record.parameterIds),
        record.start,
        record.end,
        record.status,
        record.rowCount,
        record.error,
        record.filePath,
        record.fileBytes,
        record.createdAt,
        record.startedAt,
        record.finishedAt,
      );
  }

  getJob(id: string): ExportJobRecord | null {
    const row = this.db
      .query('SELECT * FROM exports WHERE id = ?')
      .get(id) as ExportRow | null;
    return row ? rowToRecord(row) : null;
  }

  listJobs(userId: string, limit: number): ExportSummary[] {
    const rows = this.db
      .query(
        'SELECT * FROM exports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(userId, limit) as ExportRow[];
    return rows.map((row) => {
      const record = rowToRecord(row);
      return {
        id: record.id,
        deviceId: record.deviceId,
        deviceLabel: record.deviceLabel,
        parameterIds: record.parameterIds,
        start: record.start,
        end: record.end,
        status: record.status,
        rowCount: record.rowCount,
        error: record.error,
        fileBytes: record.fileBytes,
        createdAt: record.createdAt,
        finishedAt: record.finishedAt,
      };
    });
  }

  nextQueuedJob(): ExportJobRecord | null {
    const row = this.db
      .query(
        "SELECT * FROM exports WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1",
      )
      .get() as ExportRow | null;
    return row ? rowToRecord(row) : null;
  }

  update(id: string, patch: Partial<ExportJobRecord>): void {
    const current = this.getJob(id);
    if (!current) throw new Error(`export job ${id} not found`);
    const next = { ...current, ...patch };
    this.db
      .query(
        `UPDATE exports SET status = ?, row_count = ?, error = ?, file_path = ?, file_bytes = ?, started_at = ?, finished_at = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.rowCount,
        next.error,
        next.filePath,
        next.fileBytes,
        next.startedAt,
        next.finishedAt,
        id,
      );
  }

  staleProcessingJobs(olderThanMs: number): ExportJobRecord[] {
    const cutoff = Date.now() - olderThanMs;
    const rows = this.db
      .query(
        "SELECT * FROM exports WHERE status = 'processing' AND (started_at IS NULL OR started_at < ?)",
      )
      .all(cutoff) as ExportRow[];
    return rows.map(rowToRecord);
  }

  pruneBefore(cutoff: number): string[] {
    const rows = this.db
      .query('SELECT * FROM exports WHERE created_at < ?')
      .all(cutoff) as ExportRow[];
    for (const row of rows)
      this.db.query('DELETE FROM exports WHERE id = ?').run(row.id);
    return rows.filter((row) => row.file_path).map((row) => row.file_path!);
  }

  close(): void {
    this.db.close();
  }
}
