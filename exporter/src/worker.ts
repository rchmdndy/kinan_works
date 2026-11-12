import { Database as SqliteDatabase } from 'bun:sqlite';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExporterConfig } from './config';
import type { ExportJobRecord } from './types';
import { ExportStore } from './store';
import {
  buildTableHeader,
  buildWorkbookBytes,
  formatWib,
  safeExportName,
  wibSerial,
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
    this.recoverInterruptedJobs();
    void this.loop();
  }

  // This is the only worker process, so any job still 'processing' at startup
  // was interrupted by a crash or redeploy and will never finish on its own.
  recoverInterruptedJobs(): number {
    const interrupted = this.store.staleProcessingJobs(0);
    for (const job of interrupted)
      this.store.update(job.id, {
        status: 'failed',
        error: 'Ekspor terhenti karena layanan dimulai ulang. Coba lagi.',
        finishedAt: Date.now(),
      });
    return interrupted.length;
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

    const setpoints = Object.values(parameters).filter(
      (parameter) => (parameter.type ?? 'nilai') === 'control-setpoint',
    );
    const { headers, numberFormats, info } = buildTableHeader(
      selected,
      setpoints,
    );
    const hasSetpoints = setpoints.length > 0;
    const setpointHistory = hasSetpoints
      ? this.loadSetpointHistory(job, parameters)
      : null;
    const columnCount = 1 + selected.length + setpoints.length;
    // Scoped so the raw pages can be collected once the sheet rows exist.
    const { rows, rowCount } =
      job.intervalMs > 0
        ? this.buildIntervalRows(
            job,
            selected,
            setpoints,
            setpointHistory,
            columnCount,
          )
        : (() => {
            const telemetryRows: WorkerTelemetryRow[] = [];
            // Keyset pagination walks from newest to oldest inside [start, end).
            let cursor: Cursor | null = null;
            while (true) {
              const page = this.fetchPage(job, cursor);
              if (!page.length) break;
              telemetryRows.push(...page);
              const last = page.at(-1)!;
              cursor = { timestamp: last.timestamp, writeId: last.write_id };
              if (telemetryRows.length >= this.config.EXPORTER_MAX_ROWS)
                throw new Error(
                  `Ekspor melebihi batas maksimum ${this.config.EXPORTER_MAX_ROWS} baris.`,
                );
              if (
                telemetryRows.length * columnCount >
                this.config.EXPORTER_MAX_CELLS
              )
                throw new Error(
                  `Ekspor melebihi batas maksimum ${this.config.EXPORTER_MAX_CELLS} sel.`,
                );
            }
            telemetryRows.reverse();
            const events = (setpointHistory ?? []).filter(
              (row) => row.sentAt >= job.start && row.sentAt < job.end,
            );
            const rows: ExportTable['rows'] = [
              ...telemetryRows.map((row) => ({
                timestamp: row.timestamp,
                order: 1,
                key: row.write_id,
                values: JSON.parse(row.values_json) as Record<
                  string,
                  { status: string; value?: number }
                >,
              })),
              ...events.map((event) => ({
                timestamp: event.sentAt,
                order: 0,
                key: event.commandId,
                event,
              })),
            ]
              .sort(
                (a, b) =>
                  a.timestamp - b.timestamp ||
                  a.order - b.order ||
                  a.key.localeCompare(b.key),
              )
              .map((entry) => {
                if ('event' in entry) {
                  const setpointValues = setpoints.map((parameter) =>
                    entry.event.status === 'succeeded' &&
                    entry.event.parameterId === parameter.id
                      ? entry.event.target
                      : '',
                  );
                  return [
                    wibSerial(entry.timestamp),
                    ...selected.map(() => ''),
                    ...setpointValues,
                  ];
                }
                return [
                  wibSerial(entry.timestamp),
                  ...selected.map((parameter) => {
                    const reading = entry.values[parameter.id];
                    return reading?.status === 'ok'
                      ? (reading.value as number)
                      : '';
                  }),
                  ...setpoints.map(() => ''),
                ];
              });
            return { rows, rowCount: telemetryRows.length };
          })();
    const bytes = buildWorkbookBytes({
      headers,
      rows,
      info,
      numberFormats,
      sensorColumnCount: selected.length,
      setpointColumnCount: setpoints.length,
      setpointHistory,
      reportPeriod: hasSetpoints ? { start: job.start, end: job.end } : null,
    });
    const fileName = `${safeExportName(device.label)}-${job.id}.xlsx`;
    const filePath = join(this.config.EXPORTER_FILES_DIR, fileName);
    await Bun.write(filePath, bytes);
    chmodSync(filePath, 0o600);
    return {
      filePath: fileName,
      fileBytes: bytes.byteLength,
      rowCount,
    };
  }

  // One row per interval, timestamped at the interval start. The cell holds the
  // first stored reading of that interval, unmodified; intervals without a
  // reading stay empty so consecutive rows are always exactly one interval apart.
  private buildIntervalRows(
    job: ExportJobRecord,
    selected: ParameterDefinition[],
    setpoints: ParameterDefinition[],
    setpointHistory: ExportTable['setpointHistory'],
    columnCount: number,
  ): { rows: ExportTable['rows']; rowCount: number } {
    const step = job.intervalMs;
    const origin = Math.floor(job.start / step) * step;
    const buckets = Math.ceil((job.end - origin) / step);
    if (buckets > this.config.EXPORTER_MAX_ROWS)
      throw new Error(
        `Ekspor melebihi batas maksimum ${this.config.EXPORTER_MAX_ROWS} baris.`,
      );
    if (buckets * columnCount > this.config.EXPORTER_MAX_CELLS)
      throw new Error(
        `Ekspor melebihi batas maksimum ${this.config.EXPORTER_MAX_CELLS} sel.`,
      );
    // Pages run newest to oldest, so a later page entry is an earlier reading.
    const firstReading = new Map<number, string>();
    let cursor: Cursor | null = null;
    while (true) {
      const page = this.fetchPage(job, cursor);
      if (!page.length) break;
      for (const row of page)
        firstReading.set(Math.floor(row.timestamp / step), row.values_json);
      const last = page.at(-1)!;
      cursor = { timestamp: last.timestamp, writeId: last.write_id };
    }
    const applied = new Map<number, Map<string, number>>();
    for (const event of setpointHistory ?? []) {
      if (
        event.status !== 'succeeded' ||
        event.sentAt < job.start ||
        event.sentAt >= job.end
      )
        continue;
      const bucket = Math.floor(event.sentAt / step);
      const targets = applied.get(bucket) ?? new Map<string, number>();
      targets.set(event.parameterId, event.target);
      applied.set(bucket, targets);
    }
    const rows: ExportTable['rows'] = [];
    for (let i = 0; i < buckets; i += 1) {
      const bucket = origin / step + i;
      const json = firstReading.get(bucket);
      const values = json
        ? (JSON.parse(json) as Record<
            string,
            { status: string; value?: number }
          >)
        : {};
      const targets = applied.get(bucket);
      rows.push([
        wibSerial(bucket * step),
        ...selected.map((parameter) => {
          const reading = values[parameter.id];
          return reading?.status === 'ok' ? (reading.value as number) : '';
        }),
        ...setpoints.map((parameter) => targets?.get(parameter.id) ?? ''),
      ]);
    }
    return { rows, rowCount: rows.length };
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
        context: `Dalam periode ${formatWib(job.start)} – ${formatWib(job.end)} WIB (mulai inklusif, akhir eksklusif).`,
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
          sentAt: packet.timestamp,
          parameterId: parameter.id,
          label: parameter.label,
          target: packet.value as number,
          unit: parameter.unit,
          status: packet.status,
          resultAt:
            typeof packet.result?.timestamp === 'number'
              ? packet.result.timestamp
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
