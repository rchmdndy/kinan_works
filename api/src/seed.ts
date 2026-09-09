import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { seedDemo } from './demo-seed.js';

// The API normally gets env from compose; local runs must load the repo-root .env.
await Bun.file(resolve(import.meta.dir, '../../.env'))
  .text()
  .then((content) => {
    for (const line of content.split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && process.env[match[1]] === undefined)
        process.env[match[1]] = match[2];
    }
  })
  .catch(() => {});

// Local runs must target the repo-root data/, not api/data/.
if (!process.env.SQLITE_PATH)
  process.env.SQLITE_PATH = resolve(import.meta.dir, '../../data/kinan.sqlite');

const args = new Set(process.argv.slice(2));
if (![...args].every((argument) => argument === '--dry-run'))
  throw new Error('Usage: bun src/seed.ts [--dry-run]');

// Full seeding writes the shared SQLite and regenerates Mosquitto credentials,
// which requires the mosquitto_passwd binary and the container's /data paths.
// On the host, only dry-run is supported; run inside the api container instead:
//   docker compose exec api bun dist/seed.js
const inContainer = existsSync('/.dockerenv');
if (!args.has('--dry-run') && !inContainer)
  throw new Error(
    'Full seeding must run inside the api container: docker compose exec api bun dist/seed.js\n' +
      'Host runs support --dry-run only.',
  );

const result = await seedDemo(process.env, {
  dryRun: args.has('--dry-run'),
  password: process.env.KINAN_DEMO_PASSWORD,
});
console.log(JSON.stringify(result, null, 2));
