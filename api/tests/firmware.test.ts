import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { MemoryTelemetryCache } from '../src/cache.js';
import { seedDemo, DEMO_USER_ID, DEMO_DEVICE_ID } from '../src/demo-seed.js';
import { seedFirmware } from '../src/firmware-seed.js';
import { FIRMWARE_DEVICE_ID, firmwareConfig } from '../src/firmware-profile.js';
import { openDatabase, Repository } from '../src/repository.js';
import { decryptSecret } from '../src/crypto.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const broker = { sync: async () => undefined };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'firmware-test-'));
  dirs.push(dir);
  const env = {
    NODE_ENV: 'development',
    SQLITE_PATH: join(dir, 'db.sqlite'),
    ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 9).toString('base64'),
    MQTT_INGEST_PASSWORD: 'x'.repeat(16),
    MOSQUITTO_PASSWORD_FILE: join(dir, 'passwd'),
    MOSQUITTO_ACL_FILE: join(dir, 'acl'),
    FIRMWARE_OWNER_ID: DEMO_USER_ID,
  };
  await seedDemo(env, { broker });
  return env;
}
test('dedicated firmware seed preserves unrelated demo, credentials and user edits on rerun', async () => {
  const env = await fixture();
  const repo = new Repository(openDatabase(env.SQLITE_PATH));
  try {
    const before = JSON.stringify(repo.getDevice(DEMO_DEVICE_ID));
    expect((await seedFirmware(env, broker)).created).toBe(true);
    const secret = repo.getEncryptedSecret(FIRMWARE_DEVICE_ID);
    repo.updateDevice(FIRMWARE_DEVICE_ID, {
      label: 'My chamber',
      updatedAt: Date.now(),
    });
    expect((await seedFirmware(env, broker)).created).toBe(false);
    expect(repo.getDevice(FIRMWARE_DEVICE_ID)?.label).toBe('My chamber');
    expect(repo.getEncryptedSecret(FIRMWARE_DEVICE_ID)).toEqual(secret);
    expect(JSON.stringify(repo.getDevice(DEMO_DEVICE_ID))).toBe(before);
    const profile = firmwareConfig(repo.getDevice(FIRMWARE_DEVICE_ID)!);
    expect(profile?.parameters.map((p) => p.sourceKey)).toEqual([
      'tempSensor',
      'rhSensor',
      'setpointTemp',
      'setpointRH',
      'systemRunning',
    ]);
    expect(
      profile?.parameters.every(
        (p) => /^parameter_[a-f0-9]{32}$/.test(p.id) && p.id !== p.sourceKey,
      ),
    ).toBe(true);
    const device = repo.getDevice(FIRMWARE_DEVICE_ID)!;
    const edited = structuredClone(device);
    Object.values(edited.parameters)[0]!.label = 'Edited label';
    expect(firmwareConfig(edited)?.revision).not.toBe(profile?.revision);
    delete edited.parameters[Object.keys(edited.parameters)[0]!];
    expect(() => firmwareConfig(edited)).toThrow();
    expect(profile?.parameters.map((p) => p.type)).toEqual([
      'nilai',
      'nilai',
      'control-setpoint',
      'control-setpoint',
      'control-state',
    ]);
  } finally {
    repo.close();
  }
});
test('device config authenticates secret, rejects rotation and inactive devices, rate limits', async () => {
  const env = await fixture();
  await seedFirmware(env, broker);
  const runtime = await createApp(env, {
    mqtt: false,
    cache: new MemoryTelemetryCache(),
  });
  try {
    const encrypted =
      runtime.repository.getEncryptedSecret(FIRMWARE_DEVICE_ID)!;
    const secret = await decryptSecret(encrypted, Buffer.alloc(32, 9));
    const get = (token: string) =>
      runtime.app.handle(
        new Request(
          `http://localhost/api/firmware/${FIRMWARE_DEVICE_ID}/config`,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
    expect((await get('bad')).status).toBe(401);
    const response = await get(secret);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.schemaVersion).toBe(1);
    expect(body.revision).toHaveLength(64);
    expect(JSON.stringify(body)).not.toContain(secret);
    runtime.repository.updateDevice(FIRMWARE_DEVICE_ID, {
      active: false,
      updatedAt: Date.now(),
    });
    expect((await get(secret)).status).toBe(401);
    for (let i = 0; i < 30; i++) await get('bad');
    expect((await get('bad')).status).toBe(429);
  } finally {
    await runtime.close();
  }
});
test('unmarked existing firmware identity cannot be adopted', async () => {
  const env = await fixture();
  await seedFirmware(env, broker);
  const db = openDatabase(env.SQLITE_PATH);
  db.query(
    "DELETE FROM app_metadata WHERE key = 'firmware_growth_chamber_v1'",
  ).run();
  db.close();
  await expect(seedFirmware(env, broker)).rejects.toThrow('Refusing to adopt');
});
test('source keeps original variables, pins, fuzzy and local control operations', () => {
  const source = readFileSync(
    new URL('../../firmware/sketch_sep10a/sketch_sep10a.ino', import.meta.url),
    'utf8',
  );
  for (const text of [
    'float tempSensor = 0.0, rhSensor = 0.0;',
    'float setpointTemp = 25.0, setpointRH = 65.0;',
    'bool systemRunning = false;',
    '#define PIN_RPWM 25',
    '#define PIN_LPWM 26',
    '#define PIN_RELAY 32',
    '#define SHT31_ADDR 0x45',
    'Wire.begin(21, 22);',
    'fuzzy->setInput(1, errorTemp);',
    'if (rhSensor < setpointRH)',
    'systemRunning = !systemRunning;',
    'wifiOnline = !wifiOnline;',
  ])
    expect(source).toContain(text);
  expect(source).not.toContain(',xc0');
});
