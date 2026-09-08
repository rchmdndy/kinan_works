import { accessSync, constants, readFileSync } from 'node:fs';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  FIREBASE_DATABASE_URL: z.string().url(),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().min(1),
  SQLITE_PATH: z.string().min(1).default('./data/kinan.sqlite'),
  ENCRYPTION_KEY_BASE64: z.string().min(43),
  DEVICE_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  DEVICE_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  TELEMETRY_MAX_SAMPLES: z.coerce.number().int().positive().max(10_000).default(500),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30)
});

export type Config = z.infer<typeof envSchema> & { encryptionKey: Uint8Array };

const requiredConfig = ['FIREBASE_DATABASE_URL', 'FIREBASE_SERVICE_ACCOUNT_PATH', 'ENCRYPTION_KEY_BASE64'] as const;

export function isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const valuesPresent = requiredConfig.every((name) => {
    const value = env[name]?.trim();
    return value && !/(replace|YOUR_PROJECT)/i.test(value);
  });
  if (!valuesPresent) return false;
  try {
    accessSync(env.FIREBASE_SERVICE_ACCOUNT_PATH!, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(parsed.ENCRYPTION_KEY_BASE64)) throw new Error('ENCRYPTION_KEY_BASE64 must be valid base64');
  const encryptionKey = Uint8Array.from(Buffer.from(parsed.ENCRYPTION_KEY_BASE64, 'base64'));
  if (encryptionKey.length !== 32) throw new Error('ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes');
  return { ...parsed, encryptionKey };
}

export function loadServiceAccount(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !('project_id' in parsed) || !('client_email' in parsed) || !('private_key' in parsed)) {
    throw new Error('Firebase service account is missing required fields');
  }
  return parsed as Record<string, unknown>;
}
