import { afterAll, describe, expect, test } from 'bun:test';
import { createSimulator, loadSimulatorConfig, type Config } from './index.js';

const requests: Array<{ path: string; method: string; body: string }> = [];
let writeAttempts = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.text();
    requests.push({ path: `${url.pathname}${url.search}`, method: request.method, body });
    if (url.pathname === '/api/device-login') return Response.json({ customToken: 'custom', deviceId: 'device_123', credentialVersion: 2 });
    if (url.pathname === '/v1/accounts:signInWithCustomToken') return Response.json({ idToken: 'old-token', refreshToken: 'refresh-one', expiresIn: '3600' });
    if (url.pathname === '/v1/token') return Response.json({ id_token: 'new-token', refresh_token: 'refresh-two', expires_in: '3600' });
    if (url.pathname.endsWith('/telemetry/device_123.json')) {
      writeAttempts += 1;
      if (writeAttempts === 1) return Response.json({ error: 'expired token' }, { status: 401 });
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }
});
afterAll(() => server.stop(true));

const baseUrl = `http://127.0.0.1:${server.port}`;
const config: Config = {
  apiUrl: baseUrl,
  firebaseApiKey: 'key',
  databaseUrl: baseUrl,
  authBaseUrl: baseUrl,
  deviceId: 'device_123',
  deviceSecret: 'secret-secret-secret',
  parameterIds: ['parameter_1'],
  intervalMs: 10,
  historyIntervalMs: 60_000
};

describe('simulator transport', () => {
  test('logs in, refreshes snake_case tokens, retries, and writes latest/history directly', async () => {
    const simulator = createSimulator(config, { now: () => 1_700_000_000_000, randomUUID: () => 'write-id' });
    await simulator.login();
    await simulator.sendTelemetry();

    const login = requests.find((request) => request.path === '/api/device-login')!;
    expect(JSON.parse(login.body)).toEqual({ deviceId: 'device_123', secret: 'secret-secret-secret' });
    const refresh = requests.find((request) => request.path.startsWith('/v1/token?'))!;
    expect(refresh.body).toContain('refresh_token=refresh-one');
    const writes = requests.filter((request) => request.path.startsWith('/telemetry/device_123.json'));
    expect(writes.map((request) => request.path)).toEqual([
      '/telemetry/device_123.json?auth=old-token',
      '/telemetry/device_123.json?auth=new-token'
    ]);
    expect(JSON.parse(writes[1]!.body)).toEqual({
      latest: { timestamp: 1_700_000_000_000, writeId: 'write-id', values: { parameter_1: { status: 'ok', value: expect.any(Number) } } },
      'history/write-id': { timestamp: 1_700_000_000_000, writeId: 'write-id', values: { parameter_1: { status: 'ok', value: expect.any(Number) } } }
    });
  });

  test('uses the platform UUID generator without losing its receiver', async () => {
    const simulator = createSimulator(config, { now: () => 1_700_000_000_001 });
    await simulator.login();
    await expect(simulator.sendTelemetry()).resolves.toBeUndefined();
  });

  test('validates required URLs, identifiers, and intervals', () => {
    expect(() => loadSimulatorConfig({})).toThrow('SIMULATOR_DEVICE_ID is required');
    expect(() => loadSimulatorConfig({ SIMULATOR_DEVICE_ID: 'device_123', SIMULATOR_DEVICE_SECRET: 'secret', SIMULATOR_FIREBASE_API_KEY: 'key', SIMULATOR_DATABASE_URL: baseUrl, SIMULATOR_INTERVAL_MS: '0' })).toThrow('positive integer');
  });
});
