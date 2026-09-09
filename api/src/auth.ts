import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { Repository } from './repository.js';
import type { SessionUser } from './types.js';

export const SESSION_COOKIE = 'kinan_session';
export const CSRF_COOKIE = 'kinan_csrf';

export type RequestSession = {
  user: SessionUser;
  csrfHash: string;
  expiresAt: number;
  tokenHash: string;
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function token(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    'base64url',
  );
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header?: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').flatMap((part) => {
      const separator = part.indexOf('=');
      if (separator < 1) return [];
      return [
        [
          part.slice(0, separator).trim(),
          decodeURIComponent(part.slice(separator + 1).trim()),
        ],
      ];
    }),
  );
}

function serializeCookie(
  name: string,
  value: string,
  config: Config,
  httpOnly: boolean,
  maxAge?: number,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Strict',
  ];
  if (httpOnly) parts.push('HttpOnly');
  if (config.NODE_ENV === 'production') parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  return parts.join('; ');
}

export function createSession(
  repository: Repository,
  config: Config,
  userId: string,
  now = Date.now(),
): { sessionToken: string; csrfToken: string; expiresAt: number } {
  const sessionToken = token();
  const csrfToken = token();
  const expiresAt = now + config.SESSION_TTL_MS;
  repository.createSession(
    hash(sessionToken),
    userId,
    hash(csrfToken),
    now,
    expiresAt,
  );
  return { sessionToken, csrfToken, expiresAt };
}

export function sessionCookies(
  config: Config,
  sessionToken: string,
  csrfToken: string,
): string[] {
  return [
    serializeCookie(
      SESSION_COOKIE,
      sessionToken,
      config,
      true,
      config.SESSION_TTL_MS,
    ),
    serializeCookie(
      CSRF_COOKIE,
      csrfToken,
      config,
      false,
      config.SESSION_TTL_MS,
    ),
  ];
}

export function clearedSessionCookies(config: Config): string[] {
  return [
    serializeCookie(SESSION_COOKIE, '', config, true, 0),
    serializeCookie(CSRF_COOKIE, '', config, false, 0),
  ];
}

export function authenticate(
  request: Request,
  repository: Repository,
): RequestSession | null {
  const raw = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!raw) return null;
  const tokenHash = hash(raw);
  const session = repository.getSession(tokenHash, Date.now());
  return session ? { ...session, tokenHash } : null;
}

function requestOrigin(request: Request): string | null {
  const origin = request.headers.get('origin');
  if (origin) return origin;
  const referer = request.headers.get('referer');
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function configuredOrigins(config: Config): Set<string> {
  const origins = [config.APP_ORIGIN, ...config.LOCAL_APP_ORIGINS.split(',')]
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => new URL(origin).origin);
  return new Set(origins);
}

export function validateMutation(
  request: Request,
  session: RequestSession | null,
  config: Config,
): string | null {
  if (!configuredOrigins(config).has(requestOrigin(request) ?? ''))
    return 'Invalid request origin';
  if (!session)
    return request.headers.get('cookie')
      ? 'Session expired'
      : 'Authentication required';
  const csrf = request.headers.get('x-csrf-token');
  if (!csrf || !equal(hash(csrf), session.csrfHash))
    return 'Invalid CSRF token';
  return null;
}
