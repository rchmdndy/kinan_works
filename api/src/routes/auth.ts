import { Elysia } from 'elysia';
import { z } from 'zod';
import {
  authenticate,
  clearedSessionCookies,
  createSession,
  sessionCookies,
  validateMutation,
} from '../auth.js';
import type { AppDependencies } from '../app.js';
import { clientAddress, RateLimiter } from '../rate-limit.js';

const loginSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(8).max(256),
});

function error(
  set: { status?: number | string },
  status: number,
  message: string,
) {
  set.status = status;
  return { error: message };
}

export function createAuthRoutes({ config, repository }: AppDependencies) {
  const limiter = new RateLimiter(
    config.AUTH_WINDOW_MS,
    config.AUTH_MAX_ATTEMPTS,
  );
  return new Elysia({ prefix: '/api/auth' })
    .post('/login', async ({ request, body, set }) => {
      const limit = limiter.check(clientAddress(request));
      Object.assign(set.headers, limit.headers);
      if (limit.limited) return error(set, 429, 'Too many requests');

      const input = loginSchema.safeParse(body);
      if (!input.success) return error(set, 400, 'Invalid credentials');
      const user = repository.getUserByUsername(input.data.username);
      if (
        !user ||
        !user.active ||
        !(await Bun.password.verify(
          input.data.password,
          user.passwordHash,
          'argon2id',
        ))
      ) {
        return error(set, 401, 'Invalid credentials');
      }

      const session = createSession(repository, config, user.id);
      set.headers['Cache-Control'] = 'no-store';
      set.headers['Set-Cookie'] = sessionCookies(
        config,
        session.sessionToken,
        session.csrfToken,
      ).join(', ');
      return {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
        },
        csrfToken: session.csrfToken,
      };
    })
    .get('/session', ({ request, set }) => {
      const session = authenticate(request, repository);
      if (!session)
        return error(
          set,
          401,
          request.headers.get('cookie')
            ? 'Session expired'
            : 'Authentication required',
        );
      set.headers['Cache-Control'] = 'no-store';
      return { user: session.user };
    })
    .post('/logout', ({ request, set }) => {
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
      repository.deleteSession(session!.tokenHash);
      set.status = 204;
      set.headers['Set-Cookie'] = clearedSessionCookies(config).join(', ');
      return '';
    });
}
