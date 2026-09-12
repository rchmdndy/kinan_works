import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from 'redis';
import { connect } from 'mqtt';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { SimulatedDevice } from '../../simulator/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'kinan-integration-'));
const redisPort = 16000 + Math.floor(Math.random() * 1000);
const mqttPort = 17000 + Math.floor(Math.random() * 1000);
const apiPort = 18000 + Math.floor(Math.random() * 1000);
const password = `test-${crypto.randomUUID()}`;
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
  'base64',
);
const passwdHelper = join(dir, 'mosquitto_passwd');
writeFileSync(
  passwdHelper,
  '#!/bin/sh\nexec docker run --rm --user "$(id -u):$(id -g)" -v "$(dirname "$3"):/work" eclipse-mosquitto:2.0.21 mosquitto_passwd -b -c /work/$(basename "$3") "$4" "$5"\nchown "$(id -u):$(id -g)" "$3"; chmod 600 "$3"\n',
  { mode: 0o700 },
);
chmodSync(passwdHelper, 0o700);
let service: Awaited<ReturnType<typeof createApp>>;
let redis: ReturnType<typeof createClient>;
let cookie = '';
let csrf = '';
let deviceId = '';
let secret = '';
const env = {
  ...process.env,
  NODE_ENV: 'test',
  API_PORT: String(apiPort),
  APP_ORIGIN: `http://127.0.0.1:${apiPort}`,
  SQLITE_PATH: join(dir, 'test.sqlite'),
  ENCRYPTION_KEY_BASE64: key,
  REDIS_URL: `redis://127.0.0.1:${redisPort}`,
  MQTT_URL: `mqtt://127.0.0.1:${mqttPort}`,
  MQTT_INGEST_USERNAME: 'kinan-api',
  MQTT_INGEST_PASSWORD: password,
  MOSQUITTO_PASSWORD_FILE: join(dir, 'auth', 'passwd'),
  MOSQUITTO_ACL_FILE: join(dir, 'auth', 'acl'),
  MOSQUITTO_PASSWD_BIN: passwdHelper,
  TELEMETRY_MAX_CLOCK_SKEW_MS: '60000',
};
const compose = [
  'compose',
  '-p',
  `kinan-test-${process.pid}`,
  '-f',
  join(import.meta.dir, '../../docker-compose.test.yml'),
];
async function fetchApi(path: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${apiPort}${path}`, {
    ...init,
    headers: { ...init.headers, Cookie: cookie, 'X-CSRF-Token': csrf },
  });
}
async function sseSnapshot() {
  const controller = new AbortController();
  const response = await fetchApi(`/api/devices/${deviceId}/events`, {
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  let text = '';
  while (!text.includes('\n\n'))
    text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  return JSON.parse(text.match(/data: (.+)/)![1]!);
}
let server: ReturnType<Awaited<ReturnType<typeof createApp>>['app']['listen']>;
beforeAll(async () => {
  const proc = Bun.spawn(['docker', ...compose, 'up', '-d', '--wait'], {
    env: {
      ...process.env,
      TEST_REDIS_PORT: String(redisPort),
      TEST_MQTT_PORT: String(mqttPort),
      TEST_AUTH_DIR: join(dir, 'auth'),
      MQTT_INGEST_PASSWORD: password,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((await proc.exited) !== 0)
    throw new Error(await new Response(proc.stderr).text());
  await Bun.spawn(
    [
      'docker',
      'run',
      '--rm',
      '-v',
      `${join(dir, 'auth')}:/auth`,
      'alpine',
      'sh',
      '-c',
      `chown -R ${process.getuid!()}:${process.getgid!()} /auth && chmod 755 /auth && chmod 644 /auth/*`,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  ).exited;
  service = await createApp(env);
  server = service.app.listen({ port: apiPort, hostname: '127.0.0.1' });
  redis = createClient({ url: env.REDIS_URL });
  await redis.connect();
});
afterAll(async () => {
  server?.stop(true);
  await redis?.quit();
  await service?.close();
  const cleanup = Bun.spawn(['docker', ...compose, 'down', '-v'], {
    env: {
      ...process.env,
      TEST_REDIS_PORT: String(redisPort),
      TEST_MQTT_PORT: String(mqttPort),
      TEST_AUTH_DIR: join(dir, 'auth'),
      MQTT_INGEST_PASSWORD: password,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await cleanup.exited) !== 0)
    throw new Error(await new Response(cleanup.stderr).text());
  rmSync(dir, { recursive: true, force: true });
});
describe('self-hosted live integration', () => {
  test('authenticates, enforces CSRF, ingests MQTT, streams SSE, and recovers cache', async () => {
    const now = Date.now();
    service.repository.createUser(
      {
        id: 'test-user',
        username: 'operator',
        displayName: 'Operator',
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      await Bun.password.hash('correct horse battery staple', 'argon2id'),
    );
    let response = await fetch(`http://127.0.0.1:${apiPort}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: env.APP_ORIGIN },
      body: JSON.stringify({
        username: 'operator',
        password: 'correct horse battery staple',
      }),
    });
    expect(response.status).toBe(200);
    const login = (await response.json()) as { csrfToken: string };
    cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ');
    csrf = login.csrfToken;
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(cookie).toContain('kinan_session=');
    expect(cookie).toContain('kinan_csrf=');

    response = await fetch(`http://127.0.0.1:${apiPort}/api/auth/session`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const restored = (await response.json()) as { csrfToken: string };
    const restoredCookies = response.headers.getSetCookie();
    expect(restoredCookies).toHaveLength(2);
    cookie = restoredCookies.map((line) => line.split(';')[0]).join('; ');
    csrf = restored.csrfToken;

    response = await fetch(`http://127.0.0.1:${apiPort}/api/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: env.APP_ORIGIN,
      },
      body: JSON.stringify({
        label: 'Test device',
        parameters: [
          { label: 'Temperature', unit: 'C', points: 1 },
          { type: 'control-state', label: 'Switch', unit: '', points: 0 },
        ],
      }),
    });
    expect(response.status).toBe(403);
    response = await fetchApi('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: env.APP_ORIGIN },
      body: JSON.stringify({
        label: 'Test device',
        parameters: [
          { label: 'Temperature', unit: 'C', points: 1 },
          { type: 'control-state', label: 'Switch', unit: '', points: 0 },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      device: { id: string };
      secret: string;
    };
    deviceId = created.device.id;
    secret = created.secret;
    const originalParameters = Object.values(
      service.repository.getDevice(deviceId)!.parameters,
    );
    for (const parameters of [
      originalParameters.map((p) =>
        p.id === 'parameter_1'
          ? { ...p, type: 'control-state', unit: '', points: 0 }
          : p,
      ),
      originalParameters.map((p) => ({ ...p, id: 'invented_id' })),
    ]) {
      const rejected = await fetchApi(`/api/devices/${deviceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: env.APP_ORIGIN },
        body: JSON.stringify({ parameters }),
      });
      expect(rejected.status).toBe(400);
    }
    const edited = await fetchApi(`/api/devices/${deviceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: env.APP_ORIGIN },
      body: JSON.stringify({
        parameters: originalParameters.map((p) => ({
          ...p,
          label: `${p.label} edited`,
        })),
      }),
    });
    expect(edited.status).toBe(200);
    expect(
      Object.keys(service.repository.getDevice(deviceId)!.parameters),
    ).toEqual(['parameter_1', 'parameter_2']);
    await Bun.sleep(1500);
    const mqtt = connect(env.MQTT_URL, {
      username: deviceId,
      password: secret,
      clientId: deviceId,
      reconnectPeriod: 0,
    });
    await new Promise<void>((resolve, reject) => {
      mqtt.once('connect', () => resolve());
      mqtt.once('error', reject);
    });
    for (let i = 0; i < 12; i++)
      await mqtt.publishAsync(
        `devices/${deviceId}/1/telemetry`,
        JSON.stringify({
          timestamp: Date.now() + i,
          writeId: `write-id-${i}`,
          credentialVersion: 1,
          values: { parameter_1: { status: 'ok', value: i } },
        }),
        { qos: 1 },
      );
    await Bun.sleep(500);
    expect(
      service.repository.getHistory(deviceId, 0, Date.now() + 60_000, 100)
        .length,
    ).toBe(12);
    expect(await redis.lLen(`kinan:telemetry:${deviceId}:last10`)).toBe(10);
    let snapshot = await sseSnapshot();
    expect(snapshot.last10).toHaveLength(10);
    expect(snapshot.latest.values.parameter_1.value).toBe(11);
    await redis.del(`kinan:telemetry:${deviceId}:last10`);
    snapshot = await sseSnapshot();
    expect(snapshot.last10).toHaveLength(10);
    const model = new SimulatedDevice({
      deviceId,
      deviceSecret: secret,
      credentialVersion: 1,
      mqttUrl: env.MQTT_URL,
      parameterIds: ['parameter_1'],
      parameters: Object.values(
        service.repository.getDevice(deviceId)!.parameters,
      ),
      intervalMs: 1000,
    });
    const controlClient = connect(env.MQTT_URL, {
      username: `${deviceId}-v1`,
      password: secret,
      clientId: `${deviceId}-control-test`,
      reconnectPeriod: 0,
      clean: true,
      will: {
        topic: `devices/${deviceId}/availability`,
        payload: Buffer.from(
          JSON.stringify({
            credentialVersion: 1,
            connectionId: model.state.connectionId,
            timestamp: Date.now(),
            online: false,
          }),
        ),
        qos: 1,
        retain: true,
      },
    });
    await new Promise<void>((resolve, reject) => {
      controlClient.once('connect', () => resolve());
      controlClient.once('error', reject);
    });
    await controlClient.subscribeAsync(`devices/${deviceId}/commands`, {
      qos: 1,
    });
    controlClient.on('message', (_topic, payload, packet) => {
      const result = model.execute(
        JSON.parse(payload.toString()),
        Date.now(),
        packet.retain,
      );
      if (result) {
        controlClient.publish(
          `devices/${deviceId}/state`,
          JSON.stringify(model.state),
          { qos: 1, retain: true },
        );
        controlClient.publish(
          `devices/${deviceId}/command-results`,
          JSON.stringify(result),
          { qos: 1, retain: false },
        );
      }
    });
    await controlClient.publishAsync(
      `devices/${deviceId}/state`,
      JSON.stringify(model.state),
      { qos: 1, retain: true },
    );
    await controlClient.publishAsync(
      `devices/${deviceId}/availability`,
      JSON.stringify({
        credentialVersion: 1,
        connectionId: model.state.connectionId,
        timestamp: Date.now(),
        online: true,
      }),
      { qos: 1, retain: true },
    );
    await Bun.sleep(150);
    const commandId = crypto.randomUUID();
    response = await fetchApi(`/api/devices/${deviceId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: env.APP_ORIGIN },
      body: JSON.stringify({
        commandId,
        parameterId: 'parameter_2',
        value: true,
      }),
    });
    expect(response.status).toBe(202);
    await Bun.sleep(200);
    expect(service.repository.getCommand(commandId)?.status).toBe('succeeded');
    expect(
      service.repository.getControl(deviceId).state?.parameters[0]?.value,
    ).toBe(true);
    response = await fetch(
      `http://127.0.0.1:${apiPort}/api/devices/${deviceId}/commands`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          Origin: env.APP_ORIGIN,
        },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          parameterId: 'parameter_2',
          value: false,
        }),
      },
    );
    expect(response.status).toBe(403);
    controlClient.stream.destroy();
    await Bun.sleep(200);
    expect(service.repository.getControl(deviceId).availability?.online).toBe(
      false,
    );
    await controlClient.endAsync(true);
    // Reloading an ACL that removes this authenticated device must close its
    // current connection; publishing afterward could otherwise wait forever.
    const disconnected = new Promise<void>((resolve) =>
      mqtt.once('close', resolve),
    );
    response = await fetchApi(`/api/devices/${deviceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: env.APP_ORIGIN },
      body: JSON.stringify({ active: false }),
    });
    expect(response.status).toBe(200);
    await Promise.race([
      disconnected,
      Bun.sleep(5_000).then(() => {
        throw new Error(
          'Disabled device remained connected after broker policy reload',
        );
      }),
    ]);
    expect(
      service.repository.getHistory(deviceId, 0, Date.now() + 60_000, 100)
        .length,
    ).toBe(12);
    mqtt.end(true);
  });
});
