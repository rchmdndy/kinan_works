# Kinan Works

Self-hosted IoT telemetry console using Bun, SQLite, Redis, Mosquitto, and Svelte. Firebase is not part of the runtime.

## Runtime design

- SQLite is durable metadata and telemetry history/latest storage. Existing SQLite databases are migrated transactionally and backed up automatically before a schema change.
- Redis is internal-only and holds the last ten full packets per device plus pub/sub for SSE; the API falls back to process-local streaming cache if Redis is temporarily unavailable, while SQLite remains authoritative.
- Mosquitto has anonymous access disabled. Each active device uses its device ID as MQTT username and its revealable encrypted secret as password, and may publish only `devices/<deviceId>/<credentialVersion>/telemetry`. The API independently validates device active state, topic/payload credential version, timestamp skew, parameter set, and idempotent write ID.
- Human access uses local username/password with Argon2id and strict same-origin, HttpOnly cookie sessions. State-changing requests require the cookie-backed CSRF token. There is no public sign-up.

## Setup

```sh
cp -n .env.example .env
# Generate and keep a stable encryption key:
bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"
# Set ENCRYPTION_KEY_BASE64 and a random MQTT_INGEST_PASSWORD in .env.
docker compose up --build
```

Open `http://localhost:5173`. Services bind their public ports only to localhost. Docker Compose does not mount the Docker socket. The API writes Mosquitto password and ACL files atomically; the broker-side watcher reloads them without giving the API a signal/socket capability.

Create the first local operator explicitly; the command prompts for a password and never prints it:

```sh
bun run admin create-user <username> [display-name]
```

For a pre-existing legacy SQLite dataset whose devices still contain an old Firebase owner UID, explicitly link it to a known local user; no owner is guessed:

```sh
bun run admin link-owner --legacy-uid <legacy-uid> --username <username>
```

Existing Firebase data, service accounts, and encryption keys are not read, deleted, or written by this runtime. Retain them as rollback material outside the application flow.

## Simulator

Create a device in the UI, then set its ID, secret, parameter IDs, and credential version in the environment. The simulator publishes MQTT packets rather than calling a cloud service:

```sh
SIMULATOR_MQTT_URL=mqtt://127.0.0.1:1883 \
SIMULATOR_DEVICE_ID=<device-id> \
SIMULATOR_DEVICE_SECRET=<secret> \
SIMULATOR_PARAMETER_IDS=parameter_1 \
bun run --cwd simulator start
```

## Operations

`bun run prune:dry` reports SQLite telemetry older than `RETENTION_DAYS`; only `bun run prune:apply` removes it. There is no retention scheduler.

Validate local sources with:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test
```

Production API and web images can be built with their Dockerfiles. Mount a persistent `/data` directory for SQLite and Mosquitto auth files; do not put `.env`, the encryption key, or device secrets into images or source control.
