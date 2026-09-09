import { z } from 'zod';

const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Canonical browser origin. Additional loopback origins are opt-in only.
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  LOCAL_APP_ORIGINS: z.string().default(''),
  SQLITE_PATH: z.string().min(1).default('./data/kinan.sqlite'),
  ENCRYPTION_KEY_BASE64: z.string().min(43),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  MQTT_URL: z.string().url().default('mqtt://localhost:1883'),
  MQTT_INGEST_USERNAME: z.string().min(1).default('kinan-api'),
  MQTT_INGEST_PASSWORD: z.string().min(16),
  MQTT_CA_PATH: z.string().optional(),
  MQTT_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).default('true'),
  MOSQUITTO_PASSWORD_FILE: z.string().min(1).default('./data/mosquitto/passwd'),
  MOSQUITTO_ACL_FILE: z.string().min(1).default('./data/mosquitto/acl'),
  MOSQUITTO_PASSWD_BIN: z.string().min(1).default('mosquitto_passwd'),
  MOSQUITTO_RELOAD_URL: optionalUrl,
  MOSQUITTO_RELOAD_TOKEN: z.string().optional(),
  SESSION_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(31_536_000_000)
    .default(86_400_000),
  AUTH_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  API_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  API_MAX_REQUESTS: z.coerce.number().int().positive().default(300),
  TELEMETRY_MAX_SAMPLES: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(500),
  TELEMETRY_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(1_048_576)
    .default(131_072),
  TELEMETRY_MAX_CLOCK_SKEW_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(300_000),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

export type Config = z.infer<typeof envSchema> & { encryptionKey: Uint8Array };

const requiredConfig = [
  'ENCRYPTION_KEY_BASE64',
  'MQTT_INGEST_PASSWORD',
] as const;

export function isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return requiredConfig.every((name) => {
    const value = env[name]?.trim();
    return Boolean(value && !/replace|change-me|changeme/i.test(value));
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(parsed.ENCRYPTION_KEY_BASE64))
    throw new Error('ENCRYPTION_KEY_BASE64 must be valid base64');
  const encryptionKey = Uint8Array.from(
    Buffer.from(parsed.ENCRYPTION_KEY_BASE64, 'base64'),
  );
  if (encryptionKey.length !== 32)
    throw new Error('ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes');
  return { ...parsed, encryptionKey };
}
