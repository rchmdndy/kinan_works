import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from 'redis';
import { connect } from 'mqtt';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'kinan-integration-')); const redisPort = 16000 + Math.floor(Math.random() * 1000); const mqttPort = 17000 + Math.floor(Math.random() * 1000); const apiPort = 18000 + Math.floor(Math.random() * 1000);
const password = `test-${crypto.randomUUID()}`; const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'); const passwdHelper = join(dir, 'mosquitto_passwd'); writeFileSync(passwdHelper, '#!/bin/sh\nexec docker run --rm --user "$(id -u):$(id -g)" -v "$(dirname "$3"):/work" eclipse-mosquitto:2.0.21 mosquitto_passwd -b -c /work/$(basename "$3") "$4" "$5"\nchown "$(id -u):$(id -g)" "$3"; chmod 600 "$3"\n', { mode: 0o700 }); chmodSync(passwdHelper, 0o700);
let service: Awaited<ReturnType<typeof createApp>>; let redis: ReturnType<typeof createClient>; let cookie = ''; let csrf = ''; let deviceId = ''; let secret = '';
const env = { ...process.env, NODE_ENV: 'test', API_PORT: String(apiPort), APP_ORIGIN: `http://127.0.0.1:${apiPort}`, SQLITE_PATH: join(dir, 'test.sqlite'), ENCRYPTION_KEY_BASE64: key, REDIS_URL: `redis://127.0.0.1:${redisPort}`, MQTT_URL: `mqtt://127.0.0.1:${mqttPort}`, MQTT_INGEST_USERNAME: 'kinan-api', MQTT_INGEST_PASSWORD: password, MOSQUITTO_PASSWORD_FILE: join(dir, 'auth', 'passwd'), MOSQUITTO_ACL_FILE: join(dir, 'auth', 'acl'), MOSQUITTO_PASSWD_BIN: passwdHelper, TELEMETRY_MAX_CLOCK_SKEW_MS: '60000' };
const compose = ['compose', '-p', `kinan-test-${process.pid}`, '-f', join(import.meta.dir, '../../docker-compose.test.yml')];
async function fetchApi(path: string, init: RequestInit = {}) { return fetch(`http://127.0.0.1:${apiPort}${path}`, { ...init, headers: { ...init.headers, Cookie: cookie, 'X-CSRF-Token': csrf } }); }
async function sseSnapshot() { const controller = new AbortController(); const response = await fetchApi(`/api/devices/${deviceId}/events`, { signal: controller.signal }); const reader = response.body!.getReader(); let text = ''; while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value); controller.abort(); return JSON.parse(text.match(/data: (.+)/)![1]!); }
beforeAll(async () => { const proc = Bun.spawn(['docker', ...compose, 'up', '-d', '--wait'], { env: { ...process.env, TEST_REDIS_PORT: String(redisPort), TEST_MQTT_PORT: String(mqttPort), TEST_AUTH_DIR: join(dir, 'auth'), MQTT_INGEST_PASSWORD: password }, stdout: 'pipe', stderr: 'pipe' }); if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text()); await Bun.spawn(['docker', 'run', '--rm', '-v', `${join(dir, 'auth')}:/auth`, 'alpine', 'sh', '-c', `chown -R ${process.getuid!()}:${process.getgid!()} /auth && chmod 755 /auth && chmod 644 /auth/*`], { stdout: 'ignore', stderr: 'pipe' }).exited; service = await createApp(env); service.app.listen(apiPort, '127.0.0.1'); redis = createClient({ url: env.REDIS_URL }); await redis.connect(); });
afterAll(async () => { await redis?.quit(); await service?.close(); await Bun.spawn(['docker', ...compose, 'down', '-v'], { stdout: 'ignore', stderr: 'ignore' }).exited; rmSync(dir, { recursive: true, force: true }); });
describe('self-hosted live integration', () => {
 test('authenticates, enforces CSRF, ingests MQTT, streams SSE, and recovers cache', async () => {
   const now = Date.now(); service.repository.createUser({ id: 'test-user', username: 'operator', displayName: 'Operator', active: true, createdAt: now, updatedAt: now }, await Bun.password.hash('correct horse battery staple', 'argon2id'));
   let response = await fetch(`http://127.0.0.1:${apiPort}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.APP_ORIGIN }, body: JSON.stringify({ username: 'operator', password: 'correct horse battery staple' }) }); expect(response.status).toBe(200); const login = await response.json() as { csrfToken: string }; cookie = response.headers.getSetCookie().map((line) => line.split(';')[0]).join('; '); csrf = login.csrfToken;
   response = await fetch(`http://127.0.0.1:${apiPort}/api/devices`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: env.APP_ORIGIN }, body: JSON.stringify({ label: 'Test device', parameters: [{ label: 'Temperature', unit: 'C', points: 1 }] }) }); expect(response.status).toBe(403);
   response = await fetchApi('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.APP_ORIGIN }, body: JSON.stringify({ label: 'Test device', parameters: [{ label: 'Temperature', unit: 'C', points: 1 }] }) }); expect(response.status).toBe(201); const created = await response.json() as { device: { id: string }; secret: string }; deviceId = created.device.id; secret = created.secret;
   await Bun.sleep(1500);
   const mqtt = connect(env.MQTT_URL, { username: deviceId, password: secret, clientId: deviceId, reconnectPeriod: 0 }); await new Promise<void>((resolve, reject) => { mqtt.once('connect', () => resolve()); mqtt.once('error', reject); });
   for (let i = 0; i < 12; i++) await mqtt.publishAsync(`devices/${deviceId}/1/telemetry`, JSON.stringify({ timestamp: Date.now() + i, writeId: `write-id-${i}`, credentialVersion: 1, values: { parameter_1: { status: 'ok', value: i } } }), { qos: 1 });
   await Bun.sleep(500); expect(service.repository.getHistory(deviceId, 0, Date.now() + 60_000, 100).length).toBe(12); expect(await redis.lLen(`kinan:telemetry:${deviceId}:last10`)).toBe(10); let snapshot = await sseSnapshot(); expect(snapshot.last10).toHaveLength(10); expect(snapshot.latest.values.parameter_1.value).toBe(11);
   await redis.del(`kinan:telemetry:${deviceId}:last10`); snapshot = await sseSnapshot(); expect(snapshot.last10).toHaveLength(10);
   // Reloading an ACL that removes this authenticated device must close its
   // current connection; publishing afterward could otherwise wait forever.
   const disconnected = new Promise<void>((resolve) => mqtt.once('close', resolve));
   response = await fetchApi(`/api/devices/${deviceId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: env.APP_ORIGIN }, body: JSON.stringify({ active: false }) }); expect(response.status).toBe(200);
   await Promise.race([disconnected, Bun.sleep(5_000).then(() => { throw new Error('Disabled device remained connected after broker policy reload'); })]);
   expect(service.repository.getHistory(deviceId, 0, Date.now() + 60_000, 100).length).toBe(12); mqtt.end(true);
 });
});
