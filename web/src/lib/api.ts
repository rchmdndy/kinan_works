import { getIdToken } from 'firebase/auth';
import { auth } from './firebase';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = auth?.currentUser ? await getIdToken(auth.currentUser) : null;
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}
