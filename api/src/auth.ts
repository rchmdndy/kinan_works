import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Config } from './config.js';
import type { Repository } from './repository.js';
import type { SessionUser } from './types.js';

export const SESSION_COOKIE = 'kinan_session';
export const CSRF_COOKIE = 'kinan_csrf';

function csrfCookieOptions(config: Config) { return { httpOnly: false, secure: config.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/', maxAge: config.SESSION_TTL_MS }; }

type RequestSession = {
  user: SessionUser;
  csrfHash: string;
  expiresAt: number;
  tokenHash: string;
};

declare global {
  namespace Express { interface Request { session?: RequestSession } }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function token(): string { return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'); }
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header?: string): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return [];
    return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
  }));
}

function cookieOptions(config: Config) {
  return { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/', maxAge: config.SESSION_TTL_MS };
}

export function createSession(repository: Repository, config: Config, userId: string, now = Date.now()): { sessionToken: string; csrfToken: string; expiresAt: number } {
  const sessionToken = token(); const csrfToken = token(); const expiresAt = now + config.SESSION_TTL_MS;
  repository.createSession(hash(sessionToken), userId, hash(csrfToken), now, expiresAt);
  return { sessionToken, csrfToken, expiresAt };
}

export function setSessionCookie(res: Response, config: Config, sessionToken: string, csrfToken: string): void { res.cookie(SESSION_COOKIE, sessionToken, cookieOptions(config)); res.cookie(CSRF_COOKIE, csrfToken, csrfCookieOptions(config)); }
export function clearSessionCookie(res: Response, config: Config): void { res.clearCookie(SESSION_COOKIE, { ...cookieOptions(config), maxAge: undefined }); res.clearCookie(CSRF_COOKIE, { ...csrfCookieOptions(config), maxAge: undefined }); }

export function sessionAuth(repository: Repository): RequestHandler {
  return (req, res, next) => {
    const raw = parseCookies(req.header('cookie'))[SESSION_COOKIE];
    if (!raw) return res.status(401).json({ error: 'Authentication required' });
    const tokenHash = hash(raw);
    const session = repository.getSession(tokenHash, Date.now());
    if (!session) return res.status(401).json({ error: 'Session expired' });
    req.session = { ...session, tokenHash };
    next();
  };
}

function requestOrigin(req: Request): string | null {
  const origin = req.header('origin');
  if (origin) return origin;
  const referer = req.header('referer');
  if (!referer) return null;
  try { return new URL(referer).origin; } catch { return null; }
}

export function sameOrigin(config: Config): RequestHandler {
  const expected = new URL(config.APP_ORIGIN).origin;
  return (req, res, next) => requestOrigin(req) === expected ? next() : res.status(403).json({ error: 'Invalid request origin' });
}

export const csrfProtection: RequestHandler = (req, res, next) => {
  const csrf = req.header('x-csrf-token');
  if (!req.session || !csrf || !equal(hash(csrf), req.session.csrfHash)) return res.status(403).json({ error: 'Invalid CSRF token' });
  next();
};

export function ownerRoute(repository: Repository): RequestHandler[] { return [sessionAuth(repository)]; }
export function mutationRoute(repository: Repository, config: Config): RequestHandler[] { return [sameOrigin(config), sessionAuth(repository), csrfProtection]; }

export function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => { void handler(req, res, next).catch(next); };
}
