import { timingSafeEqual, createHash } from 'node:crypto';
import { Elysia } from 'elysia';
import type { AppDependencies } from '../app.js';
import { decryptSecret } from '../crypto.js';
import { firmwareConfig } from '../firmware-profile.js';
import { RateLimiter } from '../rate-limit.js';

export function createFirmwareRoutes({ repository, config }: AppDependencies) {
  const limiter = new RateLimiter(60_000, 30);
  const globalLimiter = new RateLimiter(60_000, 600);
  return new Elysia().get(
    '/api/firmware/:deviceId/config',
    async ({ params, request, set }) => {
      set.headers['Cache-Control'] = 'no-store';
      const globalLimit = globalLimiter.check('firmware');
      const limit = limiter.check(params.deviceId.slice(0, 64));
      Object.assign(set.headers, limit.headers);
      if (limit.limited || globalLimit.limited) {
        set.status = 429;
        return { error: 'Too many requests' };
      }
      const authorization = request.headers.get('authorization') ?? '';
      const supplied = authorization.startsWith('Bearer ')
        ? authorization.slice(7)
        : '';
      const device = repository.getDevice(params.deviceId);
      const encrypted = repository.getEncryptedSecret(params.deviceId);
      const expected = encrypted
        ? await decryptSecret(encrypted, config.encryptionKey)
        : '';
      const digest = (value: string) =>
        createHash('sha256').update(value).digest();
      if (
        !device?.active ||
        !expected ||
        !supplied ||
        supplied.length > 256 ||
        !timingSafeEqual(digest(supplied), digest(expected))
      ) {
        set.status = 401;
        return { error: 'Invalid device credentials' };
      }
      try {
        const result = firmwareConfig(device);
        if (result) return result;
      } catch {
        /* An edited profile must fail closed, not silently rebind hardware. */
      }
      set.status = 409;
      return { error: 'Device does not match firmware profile' };
    },
  );
}
