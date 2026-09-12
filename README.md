# Kinan Works

Self-hosted IoT telemetry console using Bun, SQLite, Redis, Mosquitto, and Svelte. Firebase is not part of the runtime.

## Runtime design

- SQLite is durable metadata and telemetry history/latest storage. Existing SQLite databases are migrated transactionally and backed up automatically before a schema change.
- Redis is internal-only and holds the last ten full packets per device plus pub/sub for SSE; the API falls back to process-local streaming cache if Redis is temporarily unavailable, while SQLite remains authoritative.
- Mosquitto has anonymous access disabled. Each active device uses its device ID as MQTT username and its revealable encrypted secret as password, and may publish only `devices/<deviceId>/<credentialVersion>/telemetry`. The API independently validates device active state, topic/payload credential version, timestamp skew, parameter set, and idempotent write ID.
- Human access uses local username/password with Argon2id and strict same-origin, HttpOnly cookie sessions. State-changing requests require the cookie-backed CSRF token. There is no public sign-up.

## Five-topic device control

The control protocol uses `devices/<id>/telemetry`, `commands`, `command-results`, `state`, and `availability` (each suffix is a separate topic under the same device prefix). Commands, results and telemetry use QoS 1, never retained. State and availability use QoS 1 with retention. Devices subscribe only to their own commands and publish only their own four reporting topics; the API has the inverse policy.

**Credentials:** new control clients use MQTT username `<id>-v<credentialVersion>` and the existing device secret. Version-scoped usernames remove old connections' control permissions when broker ACL reload completes. Legacy username `<id>` remains telemetry-only on the old versioned topic for existing firmware and benchmarks. Rotation keeps device and parameter IDs unchanged. Allow the broker watcher to apply policy changes; MQTT authorization changes are not instantaneous. Never expose the plaintext broker listener publicly. Use `mqtts://` and trusted CA certificates for external device connections; the simulator accepts `SIMULATOR_MQTT_CA_PATH` and always verifies certificates.

Dashboard parameters are authoritative and have exactly three types: `nilai` (numeric sensor), `control-state` (boolean switch), and `control-setpoint` (numeric target with finite `min < max`). There is no mode control or separate device-advertised capability list. Server-generated parameter IDs and saved types are immutable; firmware uses those same IDs. Labels, units and precision remain editable; switches have no unit or decimal inputs. Setpoint bounds are editable. New parameters default to `nilai`; existing parameters migrate to `nilai` without changing IDs or history. To add a parameter through PATCH, omit its ID; existing IDs cannot be reassigned to another type. Removed parameters are not reused and their history is not deleted.

All control payloads carry `credentialVersion`, millisecond `timestamp`, and UUID `connectionId`. State additionally carries monotonic per-connection `revision` and up to 100 unique `parameters: [{id, value}]` reporting actual control values only. Labels/types/bounds come from the dashboard, never from state. Commands carry UUID `commandId`, `parameterId`, boolean or numeric `value`, expected `revision`, and `expiresAt` (10 seconds after issue). Results carry `commandId`, `status` (`succeeded` or `rejected`) and optional `reason`. Availability carries boolean `online`; the retained offline Last Will timestamp is connection preparation time, not observed disconnection time. Numeric telemetry, charts and exports include only `nilai` parameters, never requested targets or control feedback.

The device must reject retained, expired, stale-connection, stale-revision, and invalid-value commands and deduplicate IDs. The simulator does so before changing actual state. The API permits one pending command per device. Broker PUBACK is not execution success. Timeout becomes **unknown**, never “not executed”; a late matching result can resolve it. Actual state is stored separately and never inferred from requested values or results. The API does not intentionally queue offline commands; MQTT QoS retransmissions can still occur after transport disruption, so device expiry/deduplication remains mandatory. A retained online message alone cannot enable commands: a fresh non-retained heartbeat and matching state are required (45-second freshness limit).

Session-authenticated endpoints are `GET /api/devices/:id/control`, `GET /api/devices/:id/control/events` (SSE), and CSRF-protected `POST /api/devices/:id/commands` with `{commandId, parameterId, value}`. Ownership is enforced; SSE rechecks sessions and ownership every second. Retrying the same ID/body returns the recorded command without publishing again. The realtime page uses same-origin HTTPS/API/SSE, never browser MQTT credentials. SQLite migration v4 adds control snapshots and command records; additive v5 defaults existing parameter types to `nilai` without replacing tables or history. Run one API control consumer per database; multi-instance command arbitration is not supported yet. Command history currently has no automatic retention policy (the UI/API show the latest 50 records).

### Original Growth Chamber firmware

`firmware/sketch_sep10a/sketch_sep10a.ino` preserves the original variables, defaults (`setpointTemp = 25`, `setpointRH = 65`, `systemRunning = false`), sensor reads, fuzzy/PWM/relay logic, touchscreen behavior and pins (RPWM 25, LPWM 26, relay 32, I²C 21/22, SHT31 0x45). `wifiOnline` remains the original local UI toggle, not connectivity feedback or an actuator. Only platform configuration/transport is added; remote commands update the original target/run variables and the existing loop applies outputs. A successful result confirms variable acceptance, **not physical actuator feedback**. Local touchscreen start retains its original one-second relay test; remote start does not add that test. Networking can block the loop during reconnect/publish; this is not a real-time safety controller or a new network-loss failsafe.

Create the dedicated profile using the demo account (`test@skripsi.com`) on the initialized application's environment and database:

```sh
bun api/src/firmware-seed.ts
# With the local Compose database/environment:
docker compose exec api bun dist/firmware-seed.js
```

To deliberately assign it to another existing active account, pass `FIRMWARE_OWNER_ID`. This does not run the demo seed, reset history, create an owner or replace unrelated devices. A matching ownership marker makes reruns idempotent; conflicting existing identities fail. Profile source names map to stable server-generated parameter IDs. `GET /api/firmware/growth-chamber-firmware-v1/config` requires `Authorization: Bearer <device-secret>` (not a browser login), is rate-limited and returns a SHA-256 metadata revision, credential version and the five source mappings. Missing/rekeyed/extra parameters fail closed. Configuration refresh never overwrites live targets or boot defaults.

Copy `firmware/sketch_sep10a/platform_config.example.h` to the gitignored `platform_config.h`; provision Wi-Fi, the dedicated device secret, HTTPS API origin, TLS MQTT hostname/port and trusted PEM root CA(s). Both transports verify certificates; time synchronization must succeed. The supplied local broker is plaintext loopback-only, so an external TLS endpoint or secured gateway is required; do not expose port 1883. Secret rotation requires reprovisioning the firmware secret. Never paste secrets into committed files or compiler logs.

Compile with ESP32 Arduino core 3.x, ArduinoMqttClient, ArduinoJson 7, Adafruit SHT31/BusIO, eFLL and TFT_eSPI. Preserve the board's existing TFT_eSPI display/touch setup; no display pins or calibration are inferred by the platform adapter. No flashing or physical output testing is part of this implementation.

### Simulator scenarios

Use a dedicated test device, not a production actuator. No scenario stops containers or changes services.

```sh
SIMULATOR_DEVICE_ID=<id> SIMULATOR_DEVICE_SECRET=<secret> \
SIMULATOR_CREDENTIAL_VERSION=1 SIMULATOR_PARAMETERS_FILE=/absolute/path/device.json \
SIMULATOR_MQTT_URL=mqtt://localhost:1883 SIMULATOR_INTERVAL_MS=1000 \
SIMULATOR_SCENARIO=normal bun simulator/src/index.ts
```

Save the selected dashboard device JSON (its `parameters` map, or the map itself) to `SIMULATOR_PARAMETERS_FILE`. The simulator validates IDs/types/bounds and uses no hardcoded control IDs. Reload the file/restart the simulator after changing definitions. `SIMULATOR_PARAMETER_IDS` remains a sensor-only legacy option; it never creates controls.

Select `normal` (successful commands), `reject` (simulated interlock), `delayed` (15-second delayed result after execution), `no-response` (execution with no result), `clean-offline` (offline publish after three cycles), `abrupt-offline` (socket loss and broker Last Will after three cycles), or `reconnect` (socket loss, eight-second pause, new connection and state snapshot). Reconnect currently starts a fresh simulated device with default control values; no physical persistence is claimed. SIGINT/SIGTERM publishes offline when connected. Switches default off; setpoints default to their dashboard minimum. Heartbeat interval must be 100–30000 ms.

`bun test api/tests/control.test.ts` deterministically exercises duplicate IDs, expired commands, invalid values, retained-command rejection, concurrent-command rejection, stale revisions, timeout/late results, retained recovery and credential rotation. Network scenarios above are selectable manual integration exercises, not a claim of exhaustive real-world coverage. Deduplication is process-local in the simulator and bounded to 1000 results; connection IDs invalidate commands after restart. Malformed commands with no valid correlation envelope are discarded without a result.

## Setup

```sh
cp -n .env.example .env
# Generate and keep a stable encryption key:
bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"
# Set ENCRYPTION_KEY_BASE64 and a random MQTT_INGEST_PASSWORD in .env.
docker compose up --build
```

Open `http://localhost:5173`. Services bind their public ports only to localhost. Docker Compose does not mount the Docker socket. The API writes Mosquitto password and ACL files atomically; the broker-side watcher reloads them without giving the API a signal/socket capability.

Create the first local operator explicitly. The readline password prompt **echoes input in a terminal**; use a private terminal without recording or screen sharing. Use a unique strong password (minimum eight characters):

```sh
bun run admin create-user <username> [display-name]
```

For a pre-existing legacy SQLite dataset whose devices still contain an old Firebase owner UID, explicitly link it to a known local user; no owner is guessed:

```sh
bun run admin link-owner --legacy-uid <legacy-uid> --username <username>
```

Existing Firebase data, service accounts, and encryption keys are not read, deleted, or written by this runtime. Retain them as rollback material outside the application flow.

## Local UI still shows old code

The default `docker-compose.yml` builds local sources; it does not pull the GHCR app images or bind-mount source code. Editing files or running `docker compose restart` does not rebuild the compiled UI. From the repository, rebuild and recreate the affected service:

```sh
docker compose up -d --build web
# If API sources also changed:
docker compose up -d --build api web
```

Then reload the browser (hard refresh if needed). Check that the browser URL targets this stack, not another project or proxy. `docker compose pull` alone cannot incorporate local edits.

## Simulator

Create a device in the UI, then set its ID, secret, parameter IDs, and credential version in the environment. The simulator publishes MQTT packets rather than calling a cloud service:

```sh
SIMULATOR_MQTT_URL=mqtt://127.0.0.1:1883 \
SIMULATOR_DEVICE_ID=<device-id> \
SIMULATOR_DEVICE_SECRET=<secret> \
SIMULATOR_PARAMETER_IDS=parameter_1 \
bun run --cwd simulator start
```

## Isolated 10-minute VPS benchmark

Requires Linux, local rootful Docker Compose using **systemd + cgroup v2**, Bun and installed workspace dependencies. The runtime-only system slice enforces **one aggregate CPU core, 1536 MiB RAM and zero swap** across API, Redis, Mosquitto and nginx. The Bun generator and Docker builds are outside the cap. Unsupported hosts, inaccessible counters, changed limits or containers outside the slice fail explicitly; no fallback to misleading per-container limits.

Safe validation (does not start containers or publish telemetry):

```sh
bun scripts/benchmark/stack.ts preflight
bun test scripts/benchmark/benchmark.test.ts
```

Setup and explicit workload invocation, from this repository:

```sh
bun install --frozen-lockfile
bun scripts/benchmark/stack.ts init
# Copy the printed absolute state.json path into STATE; do not use demo .env.
STATE=/absolute/path/printed/by/init/state.json
sudo -v
bun scripts/benchmark/stack.ts up "$STATE"
bun scripts/benchmark/stack.ts check "$STATE"
# Only when ready to run the full workload:
bun scripts/benchmark/run.ts "$STATE" --run-600s
# Cleanup is restricted to this unique benchmark project, including partial setup:
sudo -v
bun scripts/benchmark/stack.ts down "$STATE"
```

`sudo -v` must succeed interactively before setup/cleanup; scripts use noninteractive sudo and fail rather than ask for a password. Runtime slice units live under `/run/systemd/system` and do not survive reboot. Run `check` before every benchmark. Each `init` creates a unique project and private ignored `.benchmark/<project>` directory, fresh credentials, DB, broker auth, network and volume. Default loopback ports are HTTP **18080** and MQTT **11883**; for parallel projects change `httpPort`/`mqttPort` in that project's private state before `up`. Port conflicts fail without stopping any other stack. No existing/demo Compose services, `.env`, databases or credentials are reused. `down` retains bind-mounted DB, credentials and reports for inspection; it removes only the named project's containers/network/named volume and runtime slice. Do not remove a project directory until its stack has been taken down. Failed `up` may leave partial resources; use the same `down` command.

Provisioning happens before the timer: a local operator is bootstrapped in the isolated SQLite database, then real HTTP login/CSRF device creation provisions 20 unique broker credentials and five numeric parameters each. All 20 MQTT connections and authenticated per-device SSE subscriptions are opened before baseline. Thus baseline measures an idle _connected_ system, not an empty server. Device publishing uses QoS 1, current timestamps and unique write IDs. The first ten retain a 3-second cadence through the transition; the second ten are interleaved at 150 ms offsets.

The monotonic measured window is exactly `[0,600s)`: baseline `[0,120)`, ten devices `[120,420)`, twenty `[420,600)`. Expected scheduled counts are **0 / 1000 / 1200 = 2200**. Late slots are skipped instead of being replayed as bursts or crossing a phase boundary. Actual scheduled, publish-call/sent, PUBACK, SQLite and SSE counts are reported separately. A bounded 30-second drain and direct read-only SQLite grouped write-ID verification happen after the timer. The primary key prevents durable duplicates; verification still checks missing, duplicate and unexpected device/write-ID pairs. SSE duplicates are separately counted. One-shot `run.lock` blocks accidental reruns against populated data; create a new project rather than deleting the lock.

Reports are in the project's `results/`: all filenames share the `DD-MM-YYYY-HH:mm:ss_` prefix from local run-start time (e.g. `31-12-2026-14:00:00_report.json`): full `report.json`, `report.md`, and `phases.csv`, `messages.csv`, `resources.csv`, `errors.csv`. Per-phase broker PUBACK and publish-to-SSE latency distributions are distinct and assigned by scheduled publication phase, including late drain observations. Null percentiles mean no observations. Nearest-rank p50/p95/p99/max/count are used. Sent means MQTT publish invoked on a connected client, not proof of delivery. Transport/setup errors and incomplete verification make the run invalid; an invalid or interrupted run exits nonzero and retains available evidence.

Resource sampling targets one-second deadlines without overlapping polls. Raw samples retain scheduled and actual times and interval durations. CPU is cgroup `usage_usec` delta divided by actual elapsed time, normalized so **100% = one core**, not host CPU percentage. Memory is `memory.current`, including charged page cache/kernel memory (not Docker CLI's cache-subtracted working set). Disk I/O is cgroup `io.stat` block read/write bytes per second, not SQLite logical writes; buffered writeback can lag the timer. Aggregate values come directly from the parent slice, not sums that double-count children. Per-container counters come from verified Docker scopes; restart counts are Docker cumulative counts and parent restarts sum them. Counter resets/recreation, stopped containers, OOM kills and missed/late samples invalidate results. Phase assignment uses the scheduled interval start; actual sampling skew is retained, so boundary-straddling intervals are not claimed to be perfectly phase-pure. No disk-capacity or network-bandwidth limit is simulated. Sampling overhead and competing host activity can affect results.

This is target-load health testing, not proof of maximum capacity or long-term stability. The 512 MiB nominal OS reserve is not a host-wide reservation. Docker daemon and host overhead remain outside the server slice. No full workload is run by setup or tests.

## Operations

`bun run prune:dry` reports SQLite telemetry older than `RETENTION_DAYS`; only `bun run prune:apply` removes it. There is no retention scheduler.

Validate local sources with:

```sh
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run build
bun run test
```

Production API and web images can be built with their Dockerfiles. Mount a persistent `/data` directory for SQLite and Mosquitto auth files; do not put `.env`, the encryption key, or device secrets into images or source control.

## Code style

ESLint checks TypeScript and Svelte source with the recommended TypeScript and Svelte rules. Prettier uses two spaces and single quotes, including Svelte files. Run `bun run format` to update handwritten source, or `bun run format:check` to verify it without changes. The tooling ignores dependencies, generated output, local data, credential/configuration directories, logs, and legacy Firebase material because these files are not application source and may contain local secrets.

`bun run lint` reports correctness issues. Fix the reported source rather than disabling rules broadly.
