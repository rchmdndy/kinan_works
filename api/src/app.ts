import { Elysia } from 'elysia';
import { createFirmwareRoutes } from './routes/firmware.js';
import { ControlError, ControlService } from './control.js';
import { createControlRoutes } from './routes/control.js';
import { loadConfig } from './config.js';
import {
  MemoryTelemetryCache,
  RedisTelemetryCache,
  type TelemetryCache,
} from './cache.js';
import { MosquittoFileCredentials } from './broker.js';
import { openDatabase, Repository } from './repository.js';
import { MqttTelemetryConsumer } from './telemetry.js';
import { createAuthRoutes } from './routes/auth.js';
import { createDeviceRoutes } from './routes/devices.js';
import { createTelemetryRoutes } from './routes/telemetry.js';
import type { Config } from './config.js';

export type AppOptions = {
  cache?: TelemetryCache;
  mqtt?: boolean;
};

export type AppDependencies = {
  config: Config;
  repository: Repository;
  cache: TelemetryCache;
  broker: MosquittoFileCredentials;
  control: ControlService;
};

function securityHeaders(app: Elysia): Elysia {
  return app.onRequest(({ set }) => {
    set.headers['Content-Security-Policy'] =
      "default-src 'self';base-uri 'self';frame-ancestors 'none';form-action 'self'";
    set.headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    set.headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
    set.headers['Referrer-Policy'] = 'no-referrer';
    set.headers['Strict-Transport-Security'] =
      'max-age=15552000; includeSubDomains';
    set.headers['X-Content-Type-Options'] = 'nosniff';
    set.headers['X-Frame-Options'] = 'DENY';
    set.headers['X-Permitted-Cross-Domain-Policies'] = 'none';
    set.headers['X-XSS-Protection'] = '0';
  });
}

export async function createApp(env = process.env, options: AppOptions = {}) {
  const config = loadConfig(env);
  const repository = new Repository(openDatabase(config.SQLITE_PATH));
  let cache: TelemetryCache =
    options.cache ?? new RedisTelemetryCache(config.REDIS_URL);
  try {
    await cache.connect();
  } catch (error) {
    await cache.close().catch(() => undefined);
    if (options.cache) {
      repository.close();
      throw error;
    }
    console.error('redis unavailable; using process-local telemetry cache');
    cache = new MemoryTelemetryCache();
    await cache.connect();
  }

  const broker = new MosquittoFileCredentials(repository, config);
  const control = new ControlService(repository);
  const dependencies: AppDependencies = {
    config,
    repository,
    cache,
    broker,
    control,
  };
  const app = securityHeaders(new Elysia())
    .onError(({ code, error, set }) => {
      if (error instanceof ControlError) {
        set.status = error.status;
        return { error: error.message };
      }
      if (code === 'VALIDATION' || code === 'PARSE') {
        set.status = 400;
        return { error: 'Invalid request' };
      }
      if (code === 'NOT_FOUND') {
        set.status = 404;
        return { error: 'Not found' };
      }
      console.error(
        'request failed',
        error instanceof Error ? error.message : 'unknown',
      );
      set.status = 500;
      return { error: 'Internal server error' };
    })
    .get('/health', async () => {
      try {
        await cache.ping();
        return { ok: true, redis: true };
      } catch {
        return { ok: true, redis: false };
      }
    })
    .use(createFirmwareRoutes(dependencies))
    .use(createAuthRoutes(dependencies))
    .use(createDeviceRoutes(dependencies))
    .use(createTelemetryRoutes(dependencies))
    .use(createControlRoutes(dependencies));

  const consumer = new MqttTelemetryConsumer(
    repository,
    cache,
    config,
    control,
  );
  if (options.mqtt !== false) {
    await broker.sync();
    await consumer.connect();
  }

  return {
    app,
    repository,
    cache,
    consumer,
    close: async () => {
      await consumer.close();
      await cache.close();
      repository.close();
    },
  };
}
