import { createApp } from './app.js';
import { loadConfig } from './config.js';

export { createApp } from './app.js';

if (import.meta.main) {
  const service = await createApp();
  const port = loadConfig().API_PORT;
  service.app.listen({ port, hostname: '0.0.0.0' });
  console.log(`API listening on 0.0.0.0:${port}`);
}
