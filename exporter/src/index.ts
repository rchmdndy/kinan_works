import { Elysia } from 'elysia';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadExporterConfig } from './config';
import { ExportStore } from './store';
import { ExportWorker } from './worker';
import { createExporterRoutes } from './service';

const config = loadExporterConfig();
const store = new ExportStore(config.EXPORTER_STORE_PATH);
const worker = new ExportWorker(store, config);
worker.start();

const retentionTimer = setInterval(() => {
  try {
    const removed = store.pruneBefore(
      Date.now() - config.EXPORTER_RETENTION_MS,
    );
    for (const fileName of removed)
      rmSync(join(config.EXPORTER_FILES_DIR, fileName), { force: true });
  } catch (error) {
    console.error(
      'export retention sweep failed',
      error instanceof Error ? error.message : 'unknown',
    );
  }
}, 60_000);
retentionTimer.unref?.();

const app = new Elysia()
  .onError(({ error, set }) => {
    console.error(
      'exporter request failed',
      error instanceof Error ? error.message : 'unknown',
    );
    set.status = 500;
    return { error: 'Internal server error' };
  })
  .use(createExporterRoutes(store, config));

const server = Bun.serve({
  port: config.EXPORTER_PORT,
  fetch: app.fetch,
});
console.log(`exporter listening on port ${config.EXPORTER_PORT}`);

const cleanup = async () => {
  clearInterval(retentionTimer);
  server.stop(true);
  await worker.stop();
  store.close();
};
process.on('SIGINT', () => void cleanup());
process.on('SIGTERM', () => void cleanup());
