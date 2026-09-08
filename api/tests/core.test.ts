import type { Database as SqliteDatabase } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { decryptSecret, encryptSecret } from '../src/crypto.js';
import { importMetadata, metadataCounts, openMetadataDatabase, parameterMap, Repository, validateTelemetryParameters, type MetadataImport, type MetadataProjection } from '../src/repository.js';
import { isConfigured, loadConfig } from '../src/config.js';
import type { Database } from 'firebase-admin/database';
import { createDeviceSchema, telemetrySchema } from '../src/validation.js';
import type { Device, DeviceAccess, EncryptedSecret } from '../src/types.js';

const key = new Uint8Array(32).fill(7);
const parameters = parameterMap([{ id: 'temperature', label: 'Suhu', unit: 'C', points: 2 }, { id: 'humidity', label: 'Kelembapan', unit: '%', points: 1 }]);
const secret: EncryptedSecret = { iv: 'iv-value', ciphertext: 'ciphertext-value' };
const device = (id: string, ownerUid = 'owner-a'): Device => ({ id, ownerUid, label: id, active: true, credentialVersion: 1, createdAt: 1, updatedAt: 1, parameters });
const access = (value: Device): DeviceAccess => ({ ownerUid: value.ownerUid, active: value.active, credentialVersion: value.credentialVersion });
const firebaseStub = { ref: () => { throw new Error('unexpected telemetry access'); } } as unknown as Database;
const successfulProjection: MetadataProjection = { save: async () => {}, remove: async () => {} };

function memoryDatabase(): SqliteDatabase {
  return openMetadataDatabase(':memory:');
}

function importInput(devices: Device[]): MetadataImport {
  return {
    devices: Object.fromEntries(devices.map((value) => [value.id, value])),
    access: Object.fromEntries(devices.map((value) => [value.id, access(value)])),
    secrets: Object.fromEntries(devices.map((value) => [value.id, secret]))
  };
}

describe('security and validation primitives', () => {
  test('AES-GCM encrypts and decrypts without exposing plaintext', async () => {
    const encrypted = await encryptSecret('device-secret-value', key);
    expect(encrypted.ciphertext).not.toContain('device-secret-value');
    expect(await decryptSecret(encrypted, key)).toBe('device-secret-value');
    await expect(decryptSecret(encrypted, new Uint8Array(32).fill(8))).rejects.toThrow();
  });

  test('SQLite CRUD filters ownership and keeps encrypted secret/version', async () => {
    const sqlite = memoryDatabase();
    const repository = new Repository(sqlite, firebaseStub, successfulProjection);
    const mine = device('mine');
    const theirs = device('theirs', 'owner-b');
    await repository.saveDeviceBundle(mine, access(mine), secret);
    await repository.saveDeviceBundle(theirs, access(theirs), secret);
    expect((await repository.listDevices('owner-a')).map(({ id }) => id)).toEqual(['mine']);
    expect(await repository.getAccess('mine')).toEqual(access(mine));
    expect(await repository.getEncryptedSecret('mine')).toEqual(secret);
    await repository.updateDevice('mine', { label: 'Updated', credentialVersion: 2 });
    expect(await repository.getDevice('mine')).toMatchObject({ label: 'Updated', credentialVersion: 2 });
    await repository.deleteDevice('mine');
    expect(await repository.getDevice('mine')).toBeNull();
    sqlite.close();
  });

  test('migration is transactional, idempotent, and rejects conflicts', () => {
    const sqlite = memoryDatabase();
    const input = importInput([device('one'), device('two')]);
    expect(importMetadata(sqlite, input)).toEqual({ devices: 2, inserted: 2, unchanged: 0 });
    expect(importMetadata(sqlite, input)).toEqual({ devices: 2, inserted: 0, unchanged: 2 });
    expect(metadataCounts(sqlite)).toEqual({ devices: 2, secrets: 2, owners: 1, parameters: 4 });
    expect(() => importMetadata(sqlite, importInput([{ ...device('one'), label: 'conflict' }, device('two')]))).toThrow('refusing to overwrite');
    expect(metadataCounts(sqlite).devices).toBe(2);
    sqlite.close();
  });

  test('migration rejects incomplete cloud bundles without partial writes', () => {
    const sqlite = memoryDatabase();
    const input = importInput([device('one')]);
    delete input.secrets.one;
    expect(() => importMetadata(sqlite, input)).toThrow('incomplete');
    expect(metadataCounts(sqlite).devices).toBe(0);
    sqlite.close();
  });

  test('projection failure rolls back create, disable, rotation, and delete', async () => {
    const sqlite = memoryDatabase();
    const repository = new Repository(sqlite, firebaseStub, successfulProjection);
    const original = device('one');
    await repository.saveDeviceBundle(original, access(original), secret);
    const failure: MetadataProjection = { save: async () => { throw new Error('projection failed'); }, remove: async () => { throw new Error('projection failed'); } };
    const sameFileRepository = new Repository(sqlite, firebaseStub, failure);
    await expect(sameFileRepository.saveDeviceBundle(device('new'), access(device('new')), secret)).rejects.toThrow('projection failed');
    expect(await sameFileRepository.getDevice('new')).toBeNull();
    await expect(sameFileRepository.disableDeviceBundle({ ...original, active: false, credentialVersion: 2 })).rejects.toThrow('projection failed');
    expect(await sameFileRepository.getDevice('one')).toEqual(original);
    await expect(sameFileRepository.rotateDeviceBundle({ ...original, credentialVersion: 2 }, { ...access(original), credentialVersion: 2 }, { iv: 'new', ciphertext: 'new' })).rejects.toThrow('projection failed');
    expect(await sameFileRepository.getAccess('one')).toEqual(access(original));
    expect(await sameFileRepository.getEncryptedSecret('one')).toEqual(secret);
    await expect(sameFileRepository.deleteDevice('one')).rejects.toThrow('projection failed');
    expect(await sameFileRepository.getDevice('one')).toEqual(original);
    sqlite.close();
  });

  test('create input omits client parameter IDs and validates generated fields', () => {
    const input = createDeviceSchema.safeParse({ label: ' A ', parameters: [{ label: ' X ', unit: ' C ', points: 2 }] });
    expect(input.success).toBe(true);
    if (input.success) expect(input.data).toEqual({ label: 'A', parameters: [{ label: 'X', unit: 'C', points: 2 }] });
    expect(createDeviceSchema.safeParse({ label: 'A', parameters: [{ id: 'client-id', label: 'X', unit: '', points: 2 }] }).success).toBe(true);
    expect(createDeviceSchema.safeParse({ label: 'A', parameters: [{ label: 'X', unit: '', points: 11 }] }).success).toBe(false);
  });

  test('parameter IDs are immutable identifiers and telemetry must match exactly', () => {
    expect(validateTelemetryParameters({ temperature: { status: 'ok', value: 20 }, humidity: { status: 'error', error: 'timeout' } }, parameters)).toBe(true);
    expect(validateTelemetryParameters({ temperature: { status: 'ok', value: 20 } }, parameters)).toBe(false);
    expect(validateTelemetryParameters({ temperature: { status: 'ok', value: 20 }, humidity: { status: 'ok', value: 40 }, extra: { status: 'ok', value: 1 } }, parameters)).toBe(false);
  });

  test('malformed sensor status and non-finite values are rejected', () => {
    expect(telemetrySchema.safeParse({ credentialVersion: 1, values: { temperature: { status: 'ok', value: 1 } } }).success).toBe(true);
    expect(telemetrySchema.safeParse({ credentialVersion: 1, values: { temperature: { status: 'ok', value: Number.NaN } } }).success).toBe(false);
    expect(telemetrySchema.safeParse({ credentialVersion: 1, values: { temperature: { status: 'failed', value: 0 } } }).success).toBe(false);
  });

  test('unconfigured placeholders and absent credentials stay unconfigured', () => {
    expect(isConfigured({})).toBe(false);
    expect(isConfigured({ FIREBASE_DATABASE_URL: 'https://example.invalid', FIREBASE_SERVICE_ACCOUNT_PATH: '/does/not/exist', ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString('base64') })).toBe(false);
    expect(() => loadConfig({ FIREBASE_DATABASE_URL: 'https://example.invalid', FIREBASE_SERVICE_ACCOUNT_PATH: '/tmp/account.json', ENCRYPTION_KEY_BASE64: 'A'.repeat(44) })).toThrow('valid base64');
  });
});
