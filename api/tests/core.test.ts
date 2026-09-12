import { describe, expect, test } from 'bun:test';
import { Database as SqliteDatabase } from 'bun:sqlite';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptSecret, encryptSecret } from '../src/crypto.js';
import { validateMutation } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { MemoryTelemetryCache, RedisTelemetryCache } from '../src/cache.js';
import {
  importLegacyMetadata,
  metadataCounts,
  openDatabase,
  parameterMap,
  Repository,
  validateTelemetryParameters,
} from '../src/repository.js';
import { isConfigured, loadConfig } from '../src/config.js';
import {
  createDeviceSchema,
  telemetrySchema,
  updateDeviceSchema,
} from '../src/validation.js';
import type { Device, EncryptedSecret } from '../src/types.js';
const key = new Uint8Array(32).fill(7);
const parameters = parameterMap([
  { id: 'temperature', label: 'Suhu', unit: 'C', points: 2 },
  { id: 'humidity', label: 'Kelembapan', unit: '%', points: 1 },
]);
const secret: EncryptedSecret = {
  iv: 'iv-value',
  ciphertext: 'ciphertext-value',
};
const device = (id: string, ownerUid = 'owner-a'): Device => ({
  id,
  ownerUid,
  label: id,
  active: true,
  credentialVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  parameters,
});
function memoryDatabase(): SqliteDatabase {
  return openDatabase(':memory:');
}
function importInput(devices: Device[]) {
  return {
    devices: Object.fromEntries(devices.map((d) => [d.id, d])),
    access: Object.fromEntries(
      devices.map((d) => [
        d.id,
        {
          ownerUid: d.ownerUid,
          active: d.active,
          credentialVersion: d.credentialVersion,
        },
      ]),
    ),
    secrets: Object.fromEntries(devices.map((d) => [d.id, secret])),
  };
}
describe('security and SQLite primitives', () => {
  test('AES-GCM encrypts and decrypts', async () => {
    const encrypted = await encryptSecret('device-secret-value', key);
    expect(encrypted.ciphertext).not.toContain('device-secret-value');
    expect(await decryptSecret(encrypted, key)).toBe('device-secret-value');
  });
  test('SQLite filters ownership and persists telemetry deduplicated', () => {
    const db = memoryDatabase();
    const repo = new Repository(db);
    repo.saveDeviceBundle(device('mine'), secret);
    repo.saveDeviceBundle(device('theirs', 'owner-b'), secret);
    expect(repo.listDevices('owner-a').map((d) => d.id)).toEqual(['mine']);
    const packet = {
      timestamp: 10,
      writeId: 'write-a',
      credentialVersion: 1,
      values: {
        temperature: { status: 'ok' as const, value: 20 },
        humidity: { status: 'ok' as const, value: 30 },
      },
    };
    expect(repo.saveTelemetry('mine', packet).inserted).toBe(true);
    expect(repo.saveTelemetry('mine', packet).inserted).toBe(false);
    expect(repo.getLatest('mine')).toEqual(packet);
    db.close();
  });
  test('legacy import is idempotent and rejects conflicts', () => {
    const db = memoryDatabase();
    const input = importInput([device('one'), device('two')]);
    expect(importLegacyMetadata(db, input)).toEqual({
      devices: 2,
      inserted: 2,
      unchanged: 0,
    });
    expect(importLegacyMetadata(db, input)).toEqual({
      devices: 2,
      inserted: 0,
      unchanged: 2,
    });
    expect(metadataCounts(db)).toEqual({
      devices: 2,
      secrets: 2,
      owners: 1,
      parameters: 4,
    });
    expect(() =>
      importLegacyMetadata(
        db,
        importInput([{ ...device('one'), label: 'conflict' }, device('two')]),
      ),
    ).toThrow('refusing to overwrite');
    db.close();
  });
  test('opens a deployed v3 schema with Drizzle while preserving schema and indexes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinan-legacy-'));
    const path = join(dir, 'legacy.sqlite');
    const legacy = new SqliteDatabase(path);
    legacy.exec(`
   CREATE TABLE devices (id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, label TEXT NOT NULL, active INTEGER NOT NULL CHECK (active IN (0, 1)), credential_version INTEGER NOT NULL CHECK (credential_version > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, parameters_json TEXT NOT NULL, secret_iv TEXT NOT NULL, secret_ciphertext TEXT NOT NULL);
   CREATE INDEX devices_owner_uid ON devices(owner_uid); CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL CHECK (active IN (0, 1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL); CREATE INDEX sessions_user_id ON sessions(user_id); CREATE INDEX sessions_expires_at ON sessions(expires_at);
   CREATE TABLE owner_links (legacy_uid TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, linked_at INTEGER NOT NULL);
   CREATE TABLE telemetry (device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, write_id TEXT NOT NULL, timestamp INTEGER NOT NULL, credential_version INTEGER NOT NULL, values_json TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (device_id, write_id)); CREATE INDEX telemetry_device_time ON telemetry(device_id, timestamp DESC, write_id DESC);
   CREATE TABLE telemetry_latest (device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE, write_id TEXT NOT NULL, timestamp INTEGER NOT NULL, credential_version INTEGER NOT NULL, values_json TEXT NOT NULL, received_at INTEGER NOT NULL); PRAGMA user_version = 3;
 `);
    legacy.close();
    chmodSync(path, 0o600);
    const before = new SqliteDatabase(path)
      .query(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name",
      )
      .all();
    const db = openDatabase(path);
    const repo = new Repository(db);
    repo.saveDeviceBundle(device('legacy-device'), secret);
    expect(repo.getDevice('legacy-device')).toEqual(device('legacy-device'));
    expect(repo.listDevices('owner-a')).toHaveLength(1);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    const after = db
      .query(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name",
      )
      .all();
    expect(after).toEqual(expect.arrayContaining(before));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test('parameter and telemetry validation rejects malformed values', () => {
    expect(
      validateTelemetryParameters(
        {
          temperature: { status: 'ok', value: 20 },
          humidity: { status: 'error', error: 'timeout' },
        },
        parameters,
      ),
    ).toBe(true);
    expect(
      validateTelemetryParameters(
        { temperature: { status: 'ok', value: 20 } },
        parameters,
      ),
    ).toBe(false);
    expect(
      telemetrySchema.safeParse({
        credentialVersion: 1,
        timestamp: 1,
        writeId: 'a',
        values: { temperature: { status: 'failed', value: 0 } },
      }).success,
    ).toBe(false);
  });
  test('create input rejects client parameter IDs', () => {
    expect(
      createDeviceSchema.safeParse({
        label: ' A ',
        parameters: [{ id: 'ignored', label: ' X ', unit: ' C ', points: 2 }],
      }).success,
    ).toBe(false);
  });
  test('bounds unavailable Redis connection attempts', async () => {
    const cache = new RedisTelemetryCache('redis://127.0.0.1:1');
    const startedAt = Date.now();
    await expect(cache.connect()).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await cache.close();
  });
  test('starts auth routes without Redis or MQTT when memory cache is injected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinan-auth-app-'));
    const service = await createApp(
      {
        NODE_ENV: 'test',
        SQLITE_PATH: join(dir, 'test.sqlite'),
        ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
        MQTT_INGEST_PASSWORD: 'x'.repeat(16),
      },
      { cache: new MemoryTelemetryCache(), mqtt: false },
    );
    try {
      const now = Date.now();
      service.repository.createUser(
        {
          id: 'user-1',
          username: 'operator',
          displayName: 'Operator',
          active: true,
          createdAt: now,
          updatedAt: now,
        },
        await Bun.password.hash('correct horse battery staple', 'argon2id'),
      );
      const response = await service.app.handle(
        new Request('http://localhost/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'operator',
            password: 'correct horse battery staple',
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toContain('kinan_session=');
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('accepts only configured explicit local origins for mutations', () => {
    const config = loadConfig({
      APP_ORIGIN: 'http://localhost:5173',
      LOCAL_APP_ORIGINS: 'http://127.0.0.1:5173',
      ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 2).toString('base64'),
      MQTT_INGEST_PASSWORD: 'x'.repeat(16),
    });
    const session = {
      user: { id: 'user', username: 'demo', displayName: 'Demo' },
      csrfHash: 'unused',
      expiresAt: Date.now() + 1,
      tokenHash: 'unused',
    };
    expect(
      validateMutation(
        new Request('http://api/api/devices', {
          method: 'POST',
          headers: { Origin: 'http://127.0.0.1:5173' },
        }),
        session,
        config,
      ),
    ).toBe('Invalid CSRF token');
    expect(
      validateMutation(
        new Request('http://api/api/devices', {
          method: 'POST',
          headers: { Origin: 'http://evil.example' },
        }),
        session,
        config,
      ),
    ).toBe('Invalid request origin');
  });
  test('requires only local self-hosted secrets', () => {
    expect(isConfigured({})).toBe(false);
    expect(
      isConfigured({
        ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString('base64'),
        MQTT_INGEST_PASSWORD: 'x'.repeat(16),
      }),
    ).toBe(true);
    expect(() =>
      loadConfig({
        ENCRYPTION_KEY_BASE64: 'A'.repeat(44),
        MQTT_INGEST_PASSWORD: 'x'.repeat(16),
      }),
    ).toThrow('valid base64');
  });
});

test('exact parameter types, finite ordered bounds, switch formatting and new patch IDs', () => {
  const base = { label: 'P', unit: '', points: 0 };
  const valid = (p: object) =>
    createDeviceSchema.safeParse({ label: 'D', parameters: [p] }).success;
  expect(valid(base)).toBe(true);
  expect(valid({ ...base, type: 'control-state' })).toBe(true);
  expect(valid({ ...base, type: 'control-state', unit: 'C' })).toBe(false);
  expect(valid({ ...base, type: 'mode' })).toBe(false);
  for (const [min, max] of [
    [0, 0],
    [2, 1],
    [NaN, 1],
    [0, Infinity],
  ])
    expect(valid({ ...base, type: 'control-setpoint', min, max })).toBe(false);
  expect(valid({ ...base, type: 'control-setpoint', min: -10, max: 10 })).toBe(
    true,
  );
  expect(
    updateDeviceSchema.safeParse({ parameters: [base, base] }).success,
  ).toBe(true);
  expect(
    validateTelemetryParameters(
      { sensor: { status: 'ok', value: 3 } },
      parameterMap([
        { ...base, id: 'sensor' },
        { ...base, id: 'switch', type: 'control-state' },
      ]),
    ),
  ).toBe(true);
});

test('v4 migration preserves existing parameter IDs and numeric history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinan-v4-'));
  const path = join(dir, 'test.sqlite');
  const db = openDatabase(path);
  const repo = new Repository(db);
  repo.saveDeviceBundle(device('migration-device'), secret);
  const legacy = {
    temperature: {
      id: 'temperature',
      label: 'Old sensor',
      unit: 'C',
      points: 2,
    },
  };
  db.query('UPDATE devices SET parameters_json = ? WHERE id = ?').run(
    JSON.stringify(legacy),
    'migration-device',
  );
  const packet = {
    timestamp: 123,
    writeId: 'historical',
    credentialVersion: 1,
    values: { temperature: { status: 'ok' as const, value: 22 } },
  };
  repo.saveTelemetry('migration-device', packet);
  db.exec('PRAGMA user_version = 4');
  repo.close();
  const migrated = new Repository(openDatabase(path));
  expect(
    migrated.getDevice('migration-device')?.parameters.temperature,
  ).toEqual({ ...legacy.temperature, type: 'nilai' });
  expect(migrated.getLatest('migration-device')).toEqual(packet);
  expect(migrated.getHistory('migration-device', 0, 1000, 10)).toEqual([
    packet,
  ]);
  migrated.close();
  rmSync(dir, { recursive: true, force: true });
});
