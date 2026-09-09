import { Elysia } from 'elysia';
import { authenticate } from '../auth.js';
import type { AppDependencies } from '../app.js';
import type { TelemetryPacket } from '../types.js';

function error(
  set: { status?: number | string },
  status: number,
  message: string,
) {
  set.status = status;
  return { error: message };
}

function telemetryEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

export function createTelemetryRoutes({ repository, cache }: AppDependencies) {
  return new Elysia({ prefix: '/api/devices' }).get(
    '/:deviceId/events',
    async ({ request, params, set }) => {
      const session = authenticate(request, repository);
      if (!session)
        return error(
          set,
          401,
          request.headers.get('cookie')
            ? 'Session expired'
            : 'Authentication required',
        );
      const device = repository.getDevice(params.deviceId);
      if (!device || device.ownerUid !== session.user.id)
        return error(set, 404, 'Device not found');

      const cached = await cache.recent(device.id).catch(() => []);
      const last10 =
        cached.length === 10 ? cached : repository.getRecent(device.id);
      const encoder = new TextEncoder();
      let unsubscribe: (() => Promise<void>) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let cleanedUp = false;
      async function cleanup() {
        if (cleanedUp) return;
        cleanedUp = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
        const listener = unsubscribe;
        unsubscribe = undefined;
        await listener?.();
      }
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            controller.enqueue(
              telemetryEvent('snapshot', {
                latest: repository.getLatest(device.id),
                last10,
              }),
            );
            unsubscribe = await cache.subscribe(
              device.id,
              (packet: TelemetryPacket) => {
                try {
                  controller.enqueue(telemetryEvent('telemetry', packet));
                } catch {
                  void cleanup();
                }
              },
            );
            if (cleanedUp) {
              const listener = unsubscribe;
              unsubscribe = undefined;
              await listener?.();
              return;
            }
            heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(': heartbeat\n\n'));
              } catch {
                void cleanup();
              }
            }, 20_000);
          } catch (error) {
            await cleanup();
            controller.error(error);
          }
        },
        async cancel() {
          await cleanup();
        },
      });

      set.headers['Cache-Control'] = 'no-cache, no-transform';
      set.headers.Connection = 'keep-alive';
      set.headers['X-Accel-Buffering'] = 'no';
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  );
}
