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

export type WorkerCommandRow = {
  id: string;
  packet_json: string;
};

type ParameterDefinition = {
  id: string;
  label: string;
  unit: string;
  points: number;
  type?: string;
};

type StoredCommandPacket = {
  commandId: string;
  parameterId: string;
  value: number | boolean;
  timestamp: number;
  status: string;
  reason?: string;
  result?: { timestamp: number; reason?: string };
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
      ParameterDefinition
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
    const hasSetpoints = Object.values(parameters).some(
      (parameter) => (parameter.type ?? 'nilai') === 'control-setpoint',
    );
    const setpointHistory = hasSetpoints
      ? this.loadSetpointHistory(job, parameters)
      : null;
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
    const bytes = buildWorkbookBytes({
      headers,
      rows,
      info,
      numberFormats,
      setpointHistory,
    });
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

  private loadSetpointHistory(
    job: ExportJobRecord,
    parameters: Record<string, ParameterDefinition>,
  ): ExportTable['setpointHistory'] {
    const rows = this.telemetryDb
      .query(
        `SELECT id, packet_json FROM device_commands
         WHERE device_id = ?
           AND json_extract(packet_json, '$.parameterId') IS NOT NULL
         ORDER BY json_extract(packet_json, '$.timestamp') ASC, id ASC`,
      )
      .all(job.deviceId) as WorkerCommandRow[];
    const history = rows
      .map((row) => {
        try {
          return JSON.parse(row.packet_json) as StoredCommandPacket;
        } catch {
          return null;
        }
      })
      .filter((packet): packet is StoredCommandPacket => packet !== null)
      .map((packet) => ({ packet }))
      .filter(({ packet }) => {
        const parameter = parameters[packet.parameterId];
        return (
          (parameter?.type ?? 'nilai') === 'control-setpoint' &&
          typeof packet.value === 'number' &&
          Number.isFinite(packet.timestamp)
        );
      });
    const latestSuccessfulBeforeStart = new Map<string, StoredCommandPacket>();
    const inPeriod: StoredCommandPacket[] = [];
    for (const { packet } of history) {
      if (packet.timestamp >= job.start && packet.timestamp < job.end) {
        inPeriod.push(packet);
      } else if (
        packet.timestamp < job.start &&
        packet.status === 'succeeded'
      ) {
        latestSuccessfulBeforeStart.set(packet.parameterId, packet);
      }
    }
    const context = [...latestSuccessfulBeforeStart.values()].map((packet) => ({
      packet,
      context: 'Konteks sebelum periode; bukan keadaan aktual terjamin.',
    }));
    return [
      ...context,
      ...inPeriod.map((packet) => ({
        packet,
        context: 'Dalam periode [mulai, akhir).',
      })),
    ]
      .sort(
        (a, b) =>
          a.packet.timestamp - b.packet.timestamp ||
          a.packet.commandId.localeCompare(b.packet.commandId),
      )
      .map(({ packet, context }) => {
        const parameter = parameters[packet.parameterId]!;
        return {
          sentAt: new Date(packet.timestamp),
          parameterId: parameter.id,
          label: parameter.label,
          target: packet.value as number,
          unit: parameter.unit,
          status: packet.status,
          resultAt:
            typeof packet.result?.timestamp === 'number'
              ? new Date(packet.result.timestamp)
              : '',
          reason: packet.reason ?? packet.result?.reason ?? '',
          commandId: packet.commandId,
          context,
        };
      });
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
