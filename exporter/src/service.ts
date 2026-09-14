import { Elysia } from 'elysia';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExporterConfig } from './config';
import { ExportStore } from './store';
import {
  EXPORT_MAX_PARAMETERS,
  EXPORT_MAX_TIME_SPAN_MS,
  type CreateExportJob,
  type ExportJobRecord,
} from './types';

export function createExporterRoutes(
  store: ExportStore,
  config: ExporterConfig,
) {
  return new Elysia({ prefix: '/internal/exports' })
    .get('/health', () => ({ ok: true }))
    .post('/', async ({ body, set }) => {
      const input = body as Partial<CreateExportJob>;
      if (
        !input ||
        typeof input.userId !== 'string' ||
        !input.userId ||
        typeof input.deviceId !== 'string' ||
        !input.deviceId ||
        !Array.isArray(input.parameterIds) ||
        !input.parameterIds.length ||
        input.parameterIds.length > EXPORT_MAX_PARAMETERS ||
        input.parameterIds.some((id) => typeof id !== 'string') ||
        typeof input.start !== 'number' ||
        typeof input.end !== 'number' ||
        !Number.isFinite(input.start) ||
        !Number.isFinite(input.end) ||
        input.end <= input.start ||
        input.end - input.start > EXPORT_MAX_TIME_SPAN_MS
      ) {
        set.status = 400;
        return { error: 'Invalid export request' };
      }
      const active = store
        .listJobs(input.userId, 1_000)
        .filter(
          (job) => job.status === 'queued' || job.status === 'processing',
        ).length;
      if (active >= config.EXPORTER_MAX_ACTIVE_PER_USER) {
        set.status = 429;
        return { error: 'Too many active export jobs' };
      }
      const record = store.createJob(
        {
          userId: input.userId,
          deviceId: input.deviceId,
          parameterIds: input.parameterIds as string[],
          start: Math.trunc(input.start),
          end: Math.trunc(input.end),
        },
        '',
      );
      return { job: toStatus(record) };
    })
    .get('/', ({ query, set }) => {
      const userId = query.userId;
      if (!userId) {
        set.status = 400;
        return { error: 'userId required' };
      }
      const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
      return { exports: store.listJobs(userId, limit) };
    })
    .get('/:id', ({ params, query, set }) => {
      const job = store.getJob(params.id);
      if (!job || job.userId !== query.userId) {
        set.status = 404;
        return { error: 'Export not found' };
      }
      return { job: toStatus(job) };
    })
    .get('/:id/file', async ({ params, query, set }) => {
      const job = store.getJob(params.id);
      if (!job || job.userId !== query.userId) {
        set.status = 404;
        return { error: 'Export not found' };
      }
      if (job.status !== 'ready' || !job.filePath) {
        set.status = 409;
        return { error: 'Export is not ready' };
      }
      try {
        const bytes = await readFile(
          join(config.EXPORTER_FILES_DIR, job.filePath),
        );
        set.headers['Content-Type'] =
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        set.headers['Content-Disposition'] =
          'attachment; filename="export.xlsx"';
        set.headers['Cache-Control'] = 'no-store';
        return new Response(bytes);
      } catch {
        set.status = 410;
        return { error: 'Export file is no longer available' };
      }
    });
}

function toStatus(job: ExportJobRecord) {
  return {
    id: job.id,
    status: job.status,
    rowCount: job.rowCount,
    error: job.error,
    fileBytes: job.fileBytes,
  };
}
