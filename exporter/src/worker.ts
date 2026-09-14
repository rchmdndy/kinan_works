import { Database as SqliteDatabase } from 'bun:sqlite';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExporterConfig } from './config';
import type { ExportJobRecord } from './types';
import { ExportStore } from './store';
import {
  buildTableHeader,
  buildWorkbookBytes,
  safeExportName,
  type ExportTable,
} from './xlsx-writer';

export type WorkerTelemetryRow = {
  timestamp: number;
  write_id: string;
  values_json: string;
};

export type WorkerDeviceRow = {
  id: string;
  owner_uid: string;
  label: string;
  parameters_json: string;
};

type Cursor = { timestamp: number; writeId: string };

export class ExportWorker {
  private stopped = false;
  private readonly telemetryDb: SqliteDatabase;
  constructor(
    private readonly store: ExportStore,
    private readonly config: ExporterConfig,
  ) {
    mkdirSync(this.config.EXPORTER_FILES_DIR, { recursive: true });
    this.telemetryDb = new SqliteDatabase(this.config.EXPORTER_SQLITE_PATH, {
      readonly: true,
      strict: true,
    });
  }

  start(): void {
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.telemetryDb.close();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const job = this.store.nextQueuedJob();
      if (!job) {
        await Bun.sleep(500);
        continue;
      }
      this.process(job);
    }
  }

  private process(job: ExportJobRecord): void {
    this.store.update(job.id, { status: 'processing', startedAt: Date.now() });
    void (async () => {
      let filePath: string | null = null;
      try {
        const result = await this.runExport(job);
        filePath = result.filePath;
        this.store.update(job.id, {
          status: 'ready',
          rowCount: result.rowCount,
          filePath: result.filePath,
          fileBytes: result.fileBytes,
          finishedAt: Date.now(),
        });
      } catch (error) {
        if (filePath) rmSync(filePath, { force: true });
        this.store.update(job.id, {
          status: 'failed',
          error:
            error instanceof Error ? error.message : 'Ekspor gagal dijalankan.',
          finishedAt: Date.now(),
        });
      }
    })();
  }

  async runExport(job: ExportJobRecord): Promise<{
    filePath: string;
    fileBytes: number;
    rowCount: number;
  }> {
    const device = this.loadDevice(job);
    if (!device) throw new Error('Device tidak ditemukan pada database.');
    if (device.owner_uid !== job.userId)
      throw new Error('Device tidak dimiliki oleh pengguna.');
    const parameters = JSON.parse(device.parameters_json) as Record<
      string,
      { id: string; label: string; unit: string; points: number; type?: string }
    >;
    const selected = job.parameterIds
      .map((id) => parameters[id])
      .filter(
        (parameter): parameter is NonNullable<typeof parameter> =>
          parameter !== undefined && (parameter.type ?? 'nilai') === 'nilai',
      );
    if (!selected.length)
      throw new Error('Parameter yang dipilih tidak tersedia lagi.');

    const { headers, numberFormats, info } = buildTableHeader(selected);
    const rows: ExportTable['rows'] = [];
    // Keyset pagination walking from newest to oldest inside [start, end).
    let cursor: Cursor | null = null;
    while (true) {
      const page = this.fetchPage(job, cursor);
      if (!page.length) break;
      for (const row of page) {
        const values = JSON.parse(row.values_json) as Record<
          string,
          { status: string; value?: number }
        >;
        rows.push([
          new Date(row.timestamp),
          ...selected.map((parameter) => {
            const reading = values[parameter.id];
            return reading?.status === 'ok' ? (reading.value as number) : '';
          }),
        ]);
      }
      const last = page.at(-1)!;
      cursor = { timestamp: last.timestamp, writeId: last.write_id };
      if (rows.length >= this.config.EXPORTER_MAX_ROWS)
        throw new Error(
          `Ekspor melebihi batas maksimum ${this.config.EXPORTER_MAX_ROWS} baris.`,
        );
    }
    rows.reverse();
    const bytes = buildWorkbookBytes({ headers, rows, info, numberFormats });
    const fileName = `${safeExportName(device.label)}-${job.id}.xlsx`;
    const filePath = join(this.config.EXPORTER_FILES_DIR, fileName);
    await Bun.write(filePath, bytes);
    chmodSync(filePath, 0o600);
    return {
      filePath: fileName,
      fileBytes: bytes.byteLength,
      rowCount: rows.length,
    };
  }

  private loadDevice(job: ExportJobRecord): WorkerDeviceRow | null {
    return (
      (this.telemetryDb
        .query(
          'SELECT id, owner_uid, label, parameters_json FROM devices WHERE id = ?',
        )
        .get(job.deviceId) as WorkerDeviceRow | null) ?? null
    );
  }

  private fetchPage(
    job: ExportJobRecord,
    cursor: Cursor | null,
  ): WorkerTelemetryRow[] {
    if (cursor) {
      return this.telemetryDb
        .query(
          `SELECT timestamp, write_id, values_json FROM telemetry
           WHERE device_id = ? AND timestamp >= ? AND timestamp < ?
             AND (timestamp < ? OR (timestamp = ? AND write_id < ?))
           ORDER BY timestamp DESC, write_id DESC
           LIMIT ?`,
        )
        .all(
          job.deviceId,
          job.start,
          job.end,
          cursor.timestamp,
          cursor.timestamp,
          cursor.writeId,
          this.config.EXPORTER_PAGE_ROWS,
        ) as WorkerTelemetryRow[];
    }
    return this.telemetryDb
      .query(
        `SELECT timestamp, write_id, values_json FROM telemetry
         WHERE device_id = ? AND timestamp >= ? AND timestamp < ?
         ORDER BY timestamp DESC, write_id DESC
         LIMIT ?`,
      )
      .all(
        job.deviceId,
        job.start,
        job.end,
        this.config.EXPORTER_PAGE_ROWS,
      ) as WorkerTelemetryRow[];
  }
}
