import { z } from 'zod';

const envSchema = z.object({
  EXPORTER_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  // Shared telemetry database, opened read-only by the worker.
  EXPORTER_SQLITE_PATH: z.string().min(1).default('./data/kinan.sqlite'),
  EXPORTER_STORE_PATH: z.string().min(1).default('./data/exporter.sqlite'),
  EXPORTER_FILES_DIR: z.string().min(1).default('./data/exports'),
  EXPORTER_PAGE_ROWS: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(2_000),
  EXPORTER_MAX_ACTIVE_PER_USER: z.coerce.number().int().positive().default(5),
  EXPORTER_MAX_TOTAL_PER_USER_PER_DAY: z.coerce
    .number()
    .int()
    .positive()
    .default(100),
  EXPORTER_RETENTION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60 * 1000),
  EXPORTER_MAX_ROWS: z.coerce.number().int().positive().default(1_000_000),
});

export type ExporterConfig = z.infer<typeof envSchema>;

export function loadExporterConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExporterConfig {
  return envSchema.parse(env);
}
