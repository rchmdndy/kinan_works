export type AuthUser = { id: string; username: string };

type ApiErrorBody = { error?: string };

let csrfToken = '';

function csrfFromCookie(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.split('; ').find((part) => part.startsWith('kinan_csrf='))?.slice('kinan_csrf='.length) || '';
}

export function setCsrfToken(token: string | null | undefined) {
  csrfToken = token || '';
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error('API requests must use a same-origin /api/ path');

  const headers = new Headers(options.headers);
  if (options.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const method = (options.method || 'GET').toUpperCase();
  const csrf = csrfToken || csrfFromCookie();
  if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-CSRF-Token', csrf);

  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers
  });
  const body = response.status === 204 ? undefined : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body as ApiErrorBody | undefined;
    throw new ApiError(response.status, error?.error || `Request failed (${response.status})`);
  }
  return body as T;
}
