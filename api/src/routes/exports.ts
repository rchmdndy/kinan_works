import { Elysia } from 'elysia';
import { z } from 'zod';
import { authenticate, validateMutation } from '../auth.js';
import type { AppDependencies } from '../app.js';
import { RateLimiter } from '../rate-limit.js';

const createExportSchema = z
  .strictObject({
    deviceId: z.string().min(8).max(64),
    parameterIds: z.array(z.string().min(1).max(64)).min(1).max(100),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .refine((value) => value.end > value.start, 'Invalid export range');

type ExportJobStatus = {
  id: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  rowCount: number | null;
  error: string | null;
  fileBytes: number | null;
};

type ExportSummary = {
  id: string;
  deviceId: string;
  deviceLabel: string;
  parameterIds: string[];
  start: number;
  end: number;
  status: ExportJobStatus['status'];
  rowCount: number | null;
  error: string | null;
  fileBytes: number | null;
  createdAt: number;
  finishedAt: number | null;
};

function error(
  set: { status?: number | string },
  status: number,
  message: string,
) {
  set.status = status;
  return { error: message };
}

async function exporterFetch(
  config: AppDependencies['config'],
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = config.EXPORTER_URL.replace(/\/$/, '');
  return fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
}

export function createExportRoutes(dependencies: AppDependencies) {
  const { config, repository } = dependencies;
  const limiter = new RateLimiter(60_000, 10);
  return new Elysia({ prefix: '/api/exports' })
    .get('/', async ({ request, set }) => {
      const session = authenticate(request, repository);
      if (!session)
        return error(
          set,
          401,
          request.headers.get('cookie')
            ? 'Session expired'
            : 'Authentication required',
        );
      const response = await exporterFetch(
        config,
        `/internal/exports/?userId=${encodeURIComponent(session.user.id)}&limit=50`,
      );
      if (!response.ok)
        return error(set, 502, 'Layanan ekspor tidak tersedia.');
      const body = (await response.json()) as { exports: ExportSummary[] };
      return { exports: body.exports };
    })
    .post('/', async ({ request, body, set }) => {
      const session = authenticate(request, repository);
      const validationError = validateMutation(request, session, config);
      if (validationError)
        return error(
          set,
          validationError === 'Invalid request origin' ||
            validationError === 'Invalid CSRF token'
            ? 403
            : 401,
          validationError,
        );
      const rate = limiter.check(session!.user.id);
      set.headers['RateLimit-Limit'] = rate.headers['RateLimit-Limit']!;
      set.headers['RateLimit-Remaining'] = rate.headers['RateLimit-Remaining']!;
      if (rate.limited)
        return error(set, 429, 'Terlalu banyak permintaan ekspor.');
      const input = createExportSchema.safeParse(body);
      if (!input.success) return error(set, 400, 'Invalid export request');
      const device = repository.getDevice(input.data.deviceId);
      if (!device || device.ownerUid !== session!.user.id)
        return error(set, 404, 'Device not found');
      const available = input.data.parameterIds.filter(
        (id) =>
          device.parameters[id] &&
          (device.parameters[id]!.type ?? 'nilai') === 'nilai',
      );
      if (!available.length)
        return error(set, 400, 'Parameter yang dipilih tidak tersedia.');
      const upstream = await exporterFetch(config, '/internal/exports/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: session!.user.id,
          deviceId: device.id,
          parameterIds: available,
          start: input.data.start,
          end: input.data.end,
        }),
      });
      if (upstream.status === 429)
        return error(set, 429, 'Terlalu banyak pekerjaan ekspor aktif.');
      if (!upstream.ok)
        return error(set, 502, 'Layanan ekspor tidak tersedia.');
      const created = (await upstream.json()) as { job: ExportJobStatus };
      set.status = 201;
      return { job: { ...created.job, deviceLabel: device.label } };
    })
    .get('/:id', async ({ request, params, set }) => {
      const session = authenticate(request, repository);
      if (!session)
        return error(
          set,
          401,
          request.headers.get('cookie')
            ? 'Session expired'
            : 'Authentication required',
        );
      const response = await exporterFetch(
        config,
        `/internal/exports/${encodeURIComponent(params.id)}?userId=${encodeURIComponent(session.user.id)}`,
      );
      if (response.status === 404) return error(set, 404, 'Export not found');
      if (!response.ok)
        return error(set, 502, 'Layanan ekspor tidak tersedia.');
      const body = (await response.json()) as { job: ExportJobStatus };
      return { job: body.job };
    })
    .get('/:id/file', async ({ request, params, set }) => {
      const session = authenticate(request, repository);
      if (!session)
        return error(
          set,
          401,
          request.headers.get('cookie')
            ? 'Session expired'
            : 'Authentication required',
        );
      const response = await exporterFetch(
        config,
        `/internal/exports/${encodeURIComponent(params.id)}/file?userId=${encodeURIComponent(session.user.id)}`,
      );
      if (response.status === 404) return error(set, 404, 'Export not found');
      if (response.status === 409)
        return error(set, 409, 'Export is not ready');
      if (response.status === 410)
        return error(set, 410, 'Export file is no longer available');
      if (!response.ok || !response.body)
        return error(set, 502, 'Layanan ekspor tidak tersedia.');
      const filename = `kinan-export-${params.id}.xlsx`;
      set.headers['Content-Type'] = response.headers.get('Content-Type')!;
      set.headers['Content-Disposition'] = `attachment; filename="${filename}"`;
      set.headers['Cache-Control'] = 'no-store';
      return new Response(response.body);
    });
}
