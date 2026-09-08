import { afterEach, expect, test } from 'bun:test';
import { api, ApiError } from './api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('api sends cookie credentials to a same-origin API path without bearer tokens', async () => {
  let requestPath = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    requestPath = String(path);
    requestInit = init;
    return Response.json({ ok: true });
  }) as typeof fetch;

  expect(await api<{ ok: boolean }>('/api/devices', { method: 'POST', body: '{}' })).toEqual({ ok: true });
  expect(requestPath).toBe('/api/devices');
  expect(requestInit?.credentials).toBe('include');
  const headers = new Headers(requestInit?.headers);
  expect(headers.get('Content-Type')).toBe('application/json');
  expect(headers.has('Authorization')).toBe(false);
});

test('api rejects non-API origins before fetching', async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return Response.json({});
  }) as typeof fetch;

  await expect(api('https://example.com/api/devices')).rejects.toThrow('same-origin');
  expect(called).toBe(false);
});

test('api exposes response status without leaking response details', async () => {
  globalThis.fetch = (async () => Response.json({ error: 'Authentication required' }, { status: 401 })) as typeof fetch;
  try {
    await api('/api/auth/session');
    throw new Error('Expected request to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as Error).message).toBe('Authentication required');
  }
});
