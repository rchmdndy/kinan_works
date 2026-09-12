import { Elysia } from 'elysia';
import { authenticate, validateMutation } from '../auth.js';
import type { AppDependencies } from '../app.js';
import { ControlError } from '../control.js';

export function createControlRoutes({
  repository,
  control,
  config,
}: AppDependencies) {
  function authorized(request: Request, deviceId: string) {
    const session = authenticate(request, repository);
    if (!session) throw new ControlError(401, 'Authentication required');
    const device = repository.getDevice(deviceId);
    if (!device || device.ownerUid !== session.user.id)
      throw new ControlError(404, 'Device not found');
    return session;
  }
  return new Elysia({ prefix: '/api/devices' })
    .onError(({ error, set }) => {
      if (error instanceof ControlError) {
        set.status = error.status;
        return { error: error.message };
      }
    })
    .get('/:deviceId/control', ({ request, params, set }) => {
      authorized(request, params.deviceId);
      set.headers['Cache-Control'] = 'no-store';
      return control.snapshot(params.deviceId);
    })
    .post('/:deviceId/commands', ({ request, params, body, set }) => {
      const session = authorized(request, params.deviceId);
      const failure = validateMutation(request, session, config);
      if (failure) throw new ControlError(403, failure);
      const command = control.issue(params.deviceId, body);
      set.status = 202;
      set.headers['Cache-Control'] = 'no-store';
      return { command };
    })
    .get('/:deviceId/control/events', ({ request, params }) => {
      authorized(request, params.deviceId);
      let timer: ReturnType<typeof setInterval> | undefined;
      let closed = false;
      let last = '';
      const encoder = new TextEncoder();
      const cleanup = () => {
        closed = true;
        if (timer) clearInterval(timer);
        request.signal.removeEventListener('abort', abort);
      };
      let closeStream: (() => void) | undefined;
      const abort = () => {
        cleanup();
        closeStream?.();
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          closeStream = () => {
            try {
              controller.close();
            } catch {
              /* Already closed. */
            }
          };
          const send = () => {
            if (closed) return;
            try {
              authorized(request, params.deviceId);
              const current = JSON.stringify(control.snapshot(params.deviceId));
              if (current !== last) {
                controller.enqueue(
                  encoder.encode(`event: control\ndata: ${current}\n\n`),
                );
                last = current;
              } else controller.enqueue(encoder.encode(': heartbeat\n\n'));
            } catch {
              abort();
            }
          };
          timer = setInterval(send, 1000);
          request.signal.addEventListener('abort', abort, { once: true });
          if (request.signal.aborted) abort();
          else send();
        },
        cancel() {
          cleanup();
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    });
}
