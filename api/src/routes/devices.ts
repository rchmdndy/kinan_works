import { Elysia } from 'elysia';
import { z } from 'zod';
import { authenticate, validateMutation } from '../auth.js';
import type { AppDependencies } from '../app.js';
import {
  decryptSecret,
  encryptSecret,
  generateDeviceSecret,
} from '../crypto.js';
import { parameterMap } from '../repository.js';
import type { Device } from '../types.js';
import { createDeviceSchema, updateDeviceSchema } from '../validation.js';

const historySchema = z.object({
  start: z.coerce.number().int().nonnegative(),
  end: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().positive(),
});

function error(
  set: { status?: number | string },
  status: number,
  message: string,
  details?: unknown,
) {
  set.status = status;
  return details === undefined
    ? { error: message }
    : { error: message, details };
}

function ownedDevice(
  request: Request,
  set: { status?: number | string },
  dependencies: AppDependencies,
  deviceId: string,
) {
  const session = authenticate(request, dependencies.repository);
  if (!session)
    return {
      response: error(
        set,
        401,
        request.headers.get('cookie')
          ? 'Session expired'
          : 'Authentication required',
      ),
    };
  const device = dependencies.repository.getDevice(deviceId);
  if (!device || device.ownerUid !== session.user.id)
    return { response: error(set, 404, 'Device not found') };
  return { session, device };
}

function mutationSession(
  request: Request,
  set: { status?: number | string },
  dependencies: AppDependencies,
) {
  const session = authenticate(request, dependencies.repository);
  const validationError = validateMutation(
    request,
    session,
    dependencies.config,
  );
  if (!validationError) return session!;
  return error(
    set,
    validationError === 'Invalid request origin' ||
      validationError === 'Invalid CSRF token'
      ? 403
      : 401,
    validationError,
  );
}

export function createDeviceRoutes(dependencies: AppDependencies) {
  const { config, repository, broker } = dependencies;
  return new Elysia({ prefix: '/api/devices' })
    .get('/', ({ request, set }) => {
      const session = authenticate(request, repository);
      if (!session)
        return error(
          set,
          401,
          request.headers.get('cookie')
            ? 'Session expired'
            : 'Authentication required',
        );
      return { devices: repository.listDevices(session.user.id) };
    })
    .post('/', async ({ request, body, set }) => {
      const session = mutationSession(request, set, dependencies);
      if (!('user' in session)) return session;
      const input = createDeviceSchema.safeParse(body);
      if (!input.success)
        return error(set, 400, 'Invalid device', input.error.flatten());

      const id = crypto.randomUUID().replaceAll('-', '');
      const now = Date.now();
      const secret = generateDeviceSecret();
      const parameters = parameterMap(
        input.data.parameters.map((parameter, index) => ({
          ...parameter,
          id: `parameter_${index + 1}`,
        })),
      );
      const device: Device = {
        id,
        ownerUid: session.user.id,
        label: input.data.label,
        active: true,
        credentialVersion: 1,
        createdAt: now,
        updatedAt: now,
        parameters,
      };
      repository.saveDeviceBundle(
        device,
        await encryptSecret(secret, config.encryptionKey),
      );
      await broker.sync();
      set.status = 201;
      set.headers['Cache-Control'] = 'no-store';
      return { device, secret };
    })
    .get('/:deviceId/secret', async ({ request, params, set }) => {
      const owned = ownedDevice(request, set, dependencies, params.deviceId);
      if ('response' in owned) return owned.response;
      const encrypted = repository.getEncryptedSecret(owned.device.id);
      if (!encrypted) return error(set, 404, 'Device secret unavailable');
      set.headers['Cache-Control'] = 'no-store';
      return {
        deviceId: owned.device.id,
        credentialVersion: owned.device.credentialVersion,
        secret: await decryptSecret(encrypted, config.encryptionKey),
      };
    })
    .patch('/:deviceId', async ({ request, params, body, set }) => {
      const session = mutationSession(request, set, dependencies);
      if (!('user' in session)) return session;
      const input = updateDeviceSchema.safeParse(body);
      if (!input.success)
        return error(set, 400, 'Invalid device', input.error.flatten());
      const device = repository.getDevice(params.deviceId);
      if (!device || device.ownerUid !== session.user.id)
        return error(set, 404, 'Device not found');
      const patch: Partial<Device> = { updatedAt: Date.now() };
      if (input.data.label !== undefined) patch.label = input.data.label;
      if (input.data.parameters !== undefined)
        patch.parameters = parameterMap(input.data.parameters);
      if (input.data.active !== undefined) patch.active = input.data.active;
      const updated = repository.updateDevice(device.id, patch);
      await broker.sync();
      return { device: updated };
    })
    .post('/:deviceId/rotate', async ({ request, params, set }) => {
      const session = mutationSession(request, set, dependencies);
      if (!('user' in session)) return session;
      const device = repository.getDevice(params.deviceId);
      if (!device || device.ownerUid !== session.user.id)
        return error(set, 404, 'Device not found');
      const secret = generateDeviceSecret();
      const updated = repository.updateDevice(
        device.id,
        {
          credentialVersion: device.credentialVersion + 1,
          updatedAt: Date.now(),
        },
        await encryptSecret(secret, config.encryptionKey),
      );
      await broker.sync();
      set.headers['Cache-Control'] = 'no-store';
      return {
        deviceId: updated.id,
        credentialVersion: updated.credentialVersion,
        secret,
      };
    })
    .get('/:deviceId/latest', ({ request, params, set }) => {
      const owned = ownedDevice(request, set, dependencies, params.deviceId);
      if ('response' in owned) return owned.response;
      return { latest: repository.getLatest(owned.device.id) };
    })
    .get('/:deviceId/history', ({ request, params, query, set }) => {
      const owned = ownedDevice(request, set, dependencies, params.deviceId);
      if ('response' in owned) return owned.response;
      const parsed = historySchema.safeParse({
        ...query,
        limit: query.limit ?? config.TELEMETRY_MAX_SAMPLES,
      });
      if (
        !parsed.success ||
        parsed.data.end <= parsed.data.start ||
        parsed.data.limit > config.TELEMETRY_MAX_SAMPLES
      ) {
        return error(set, 400, 'Invalid history range');
      }
      return {
        device: owned.device,
        samples: repository.getHistory(
          owned.device.id,
          parsed.data.start,
          parsed.data.end,
          parsed.data.limit,
        ),
      };
    });
}
