import { Database as SqliteDatabase } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database as FirebaseDatabase, Reference } from 'firebase-admin/database';
import type { Device, DeviceAccess, EncryptedSecret, Parameter, SensorValue, TelemetryPacket } from './types.js';

type StoredDevice = {
  id: string;
  owner_uid: string;
  label: string;
  active: number;
  credential_version: number;
  created_at: number;
  updated_at: number;
  parameters_json: string;
  secret_iv: string;
  secret_ciphertext: string;
};

export type MetadataImport = {
  devices: Record<string, Device>;
  access: Record<string, DeviceAccess>;
  secrets: Record<string, EncryptedSecret>;
};

export interface MetadataProjection {
  save(device: Device, access: DeviceAccess, secret: EncryptedSecret): Promise<void>;
  remove(deviceId: string): Promise<void>;
}

export class FirebaseMetadataProjection implements MetadataProjection {
  constructor(private readonly db: FirebaseDatabase) {}

  async save(device: Device, access: DeviceAccess, secret: EncryptedSecret): Promise<void> {
    await this.db.ref().update({
      [`devices/${device.id}`]: device,
      [`backend/deviceAccess/${device.id}`]: access,
      [`backend/deviceSecrets/${device.id}`]: secret
    });
  }

  async remove(deviceId: string): Promise<void> {
    await this.db.ref().update({
      [`devices/${deviceId}`]: null,
      [`backend/deviceAccess/${deviceId}`]: null,
      [`backend/deviceSecrets/${deviceId}`]: null
    });
  }
}

export function openMetadataDatabase(path: string): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new SqliteDatabase(path, { create: true, strict: true });
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') chmodSync(path, 0o600);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      owner_uid TEXT NOT NULL,
      label TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      credential_version INTEGER NOT NULL CHECK (credential_version > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      parameters_json TEXT NOT NULL,
      secret_iv TEXT NOT NULL,
      secret_ciphertext TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS devices_owner_uid ON devices(owner_uid);
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return sqlite;
}

export function assertMetadataMigrated(sqlite: SqliteDatabase): void {
  const row = sqlite.query("SELECT value FROM app_metadata WHERE key = 'firebase_metadata_imported_at'").get() as { value: string } | null;
  if (!row) throw new Error('SQLite metadata is not migrated; run `bun run migrate:sqlite` before starting the API');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

function deviceToRow(device: Device, secret: EncryptedSecret): StoredDevice {
  return {
    id: device.id,
    owner_uid: device.ownerUid,
    label: device.label,
    active: device.active ? 1 : 0,
    credential_version: device.credentialVersion,
    created_at: device.createdAt,
    updated_at: device.updatedAt,
    parameters_json: stableJson(device.parameters),
    secret_iv: secret.iv,
    secret_ciphertext: secret.ciphertext
  };
}

function rowToDevice(row: StoredDevice): Device {
  return {
    id: row.id,
    ownerUid: row.owner_uid,
    label: row.label,
    active: row.active === 1,
    credentialVersion: row.credential_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parameters: JSON.parse(row.parameters_json) as Record<string, Parameter>
  };
}

const rowColumns = 'id, owner_uid, label, active, credential_version, created_at, updated_at, parameters_json, secret_iv, secret_ciphertext';

function sameRow(left: StoredDevice, right: StoredDevice): boolean {
  return Object.keys(left).every((key) => left[key as keyof StoredDevice] === right[key as keyof StoredDevice]);
}

function validateImportBundle(id: string, device: Device, access: DeviceAccess, secret: EncryptedSecret): void {
  const validParameter = (parameterId: string, value: Parameter) => value && value.id === parameterId && typeof value.label === 'string' && typeof value.unit === 'string' && Number.isInteger(value.points) && value.points >= 0 && value.points <= 10;
  if (!device || device.id !== id || typeof device.ownerUid !== 'string' || !device.ownerUid || typeof device.label !== 'string' || typeof device.active !== 'boolean' || !Number.isInteger(device.credentialVersion) || device.credentialVersion < 1 || !Number.isSafeInteger(device.createdAt) || !Number.isSafeInteger(device.updatedAt) || !device.parameters || Object.entries(device.parameters).some(([parameterId, value]) => !validParameter(parameterId, value))) {
    throw new Error(`Invalid device metadata for ${id}`);
  }
  if (!access || typeof access.ownerUid !== 'string' || typeof access.active !== 'boolean' || !Number.isInteger(access.credentialVersion) || !secret || typeof secret.iv !== 'string' || !secret.iv || typeof secret.ciphertext !== 'string' || !secret.ciphertext) {
    throw new Error(`Invalid access or encrypted secret for ${id}`);
  }
}

export function importMetadata(sqlite: SqliteDatabase, input: MetadataImport, allowEmpty = false): { devices: number; inserted: number; unchanged: number } {
  const deviceIds = Object.keys(input.devices).sort();
  const accessIds = Object.keys(input.access).sort();
  const secretIds = Object.keys(input.secrets).sort();
  if (!allowEmpty && deviceIds.length === 0) throw new Error('Firebase metadata is empty; refusing to mark migration complete without --allow-empty');
  if (stableJson(deviceIds) !== stableJson(accessIds) || stableJson(deviceIds) !== stableJson(secretIds)) {
    throw new Error(`Firebase metadata is incomplete: devices=${deviceIds.length}, access=${accessIds.length}, secrets=${secretIds.length}`);
  }

  let inserted = 0;
  let unchanged = 0;
  const run = sqlite.transaction(() => {
    for (const id of deviceIds) {
      const device = input.devices[id]!;
      const access = input.access[id]!;
      const secret = input.secrets[id]!;
      validateImportBundle(id, device, access, secret);
      if (device.ownerUid !== access.ownerUid || device.active !== access.active || device.credentialVersion !== access.credentialVersion) {
        throw new Error(`Device/access conflict for ${id}`);
      }
      const incoming = deviceToRow(device, secret);
      const existing = sqlite.query(`SELECT ${rowColumns} FROM devices WHERE id = ?`).get(id) as StoredDevice | null;
      if (existing) {
        if (!sameRow(existing, incoming)) throw new Error(`SQLite conflict for existing device ${id}; refusing to overwrite`);
        unchanged++;
        continue;
      }
      sqlite.query(`INSERT INTO devices (${rowColumns}) VALUES ($id, $owner_uid, $label, $active, $credential_version, $created_at, $updated_at, $parameters_json, $secret_iv, $secret_ciphertext)`).run(incoming);
      inserted++;
    }
    const localIds = (sqlite.query('SELECT id FROM devices ORDER BY id').all() as Array<{ id: string }>).map(({ id }) => id);
    if (stableJson(localIds) !== stableJson(deviceIds)) throw new Error(`SQLite contains ${localIds.length} devices but Firebase contains ${deviceIds.length}; refusing mixed datasets`);
    sqlite.query("INSERT INTO app_metadata (key, value) VALUES ('firebase_metadata_imported_at', ?) ON CONFLICT(key) DO NOTHING").run(new Date().toISOString());
  });
  run();
  return { devices: deviceIds.length, inserted, unchanged };
}

export function metadataCounts(sqlite: SqliteDatabase): { devices: number; secrets: number; owners: number; parameters: number } {
  const rows = sqlite.query(`SELECT ${rowColumns} FROM devices`).all() as StoredDevice[];
  return {
    devices: rows.length,
    secrets: rows.filter(({ secret_iv, secret_ciphertext }) => secret_iv.length > 0 && secret_ciphertext.length > 0).length,
    owners: new Set(rows.map(({ owner_uid }) => owner_uid)).size,
    parameters: rows.reduce((count, row) => count + Object.keys(JSON.parse(row.parameters_json) as object).length, 0)
  };
}

export function listMetadataDeviceIds(sqlite: SqliteDatabase): string[] {
  return (sqlite.query('SELECT id FROM devices ORDER BY id').all() as Array<{ id: string }>).map(({ id }) => id);
}

export class Repository {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly sqlite: SqliteDatabase,
    private readonly firebase: FirebaseDatabase,
    private readonly projection: MetadataProjection = new FirebaseMetadataProjection(firebase),
    private readonly writer: SqliteDatabase = sqlite
  ) {}

  private ref(path: string): Reference { return this.firebase.ref(path); }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private writeRow(device: Device, secret: EncryptedSecret): void {
    const row = deviceToRow(device, secret);
    this.writer.query(`INSERT INTO devices (${rowColumns}) VALUES ($id, $owner_uid, $label, $active, $credential_version, $created_at, $updated_at, $parameters_json, $secret_iv, $secret_ciphertext)
      ON CONFLICT(id) DO UPDATE SET owner_uid=$owner_uid, label=$label, active=$active, credential_version=$credential_version, created_at=$created_at, updated_at=$updated_at, parameters_json=$parameters_json, secret_iv=$secret_iv, secret_ciphertext=$secret_ciphertext`).run(row);
  }

  private async saveProjected(device: Device, access: DeviceAccess, secret: EncryptedSecret): Promise<void> {
    await this.serialize(async () => {
      this.writer.exec('BEGIN IMMEDIATE');
      try {
        this.writeRow(device, secret);
        await this.projection.save(device, access, secret);
        this.writer.exec('COMMIT');
      } catch (error) {
        this.writer.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async getDevice(deviceId: string): Promise<Device | null> {
    const row = this.sqlite.query(`SELECT ${rowColumns} FROM devices WHERE id = ?`).get(deviceId) as StoredDevice | null;
    return row ? rowToDevice(row) : null;
  }

  async listDevices(ownerUid: string): Promise<Device[]> {
    return (this.sqlite.query(`SELECT ${rowColumns} FROM devices WHERE owner_uid = ? ORDER BY created_at, id`).all(ownerUid) as StoredDevice[]).map(rowToDevice);
  }

  async saveDeviceBundle(device: Device, access: DeviceAccess, secret: EncryptedSecret): Promise<void> {
    if (await this.getDevice(device.id)) throw new Error(`Device ${device.id} already exists`);
    await this.saveProjected(device, access, secret);
  }

  async saveDevice(device: Device): Promise<void> {
    const secret = await this.getEncryptedSecret(device.id);
    if (!secret) throw new Error(`Device secret unavailable for ${device.id}`);
    await this.saveProjected(device, { ownerUid: device.ownerUid, active: device.active, credentialVersion: device.credentialVersion }, secret);
  }

  async rotateDeviceBundle(device: Device, access: DeviceAccess, secret: EncryptedSecret): Promise<void> {
    await this.saveProjected(device, access, secret);
  }

  async disableDeviceBundle(device: Device): Promise<void> {
    const secret = await this.getEncryptedSecret(device.id);
    if (!secret) throw new Error(`Device secret unavailable for ${device.id}`);
    await this.saveProjected(device, { ownerUid: device.ownerUid, active: false, credentialVersion: device.credentialVersion }, secret);
  }

  async updateDevice(deviceId: string, data: Partial<Device>): Promise<void> {
    const current = await this.getDevice(deviceId);
    if (!current) throw new Error(`Device ${deviceId} not found`);
    await this.saveDevice({ ...current, ...data });
  }

  async deleteDevice(deviceId: string): Promise<void> {
    await this.serialize(async () => {
      this.writer.exec('BEGIN IMMEDIATE');
      try {
        this.writer.query('DELETE FROM devices WHERE id = ?').run(deviceId);
        await this.projection.remove(deviceId);
        this.writer.exec('COMMIT');
      } catch (error) {
        this.writer.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async getAccess(deviceId: string): Promise<DeviceAccess | null> {
    const device = await this.getDevice(deviceId);
    return device ? { ownerUid: device.ownerUid, active: device.active, credentialVersion: device.credentialVersion } : null;
  }

  async getEncryptedSecret(deviceId: string): Promise<EncryptedSecret | null> {
    const row = this.sqlite.query('SELECT secret_iv, secret_ciphertext FROM devices WHERE id = ?').get(deviceId) as Pick<StoredDevice, 'secret_iv' | 'secret_ciphertext'> | null;
    return row ? { iv: row.secret_iv, ciphertext: row.secret_ciphertext } : null;
  }

  async saveLatest(deviceId: string, packet: TelemetryPacket): Promise<void> {
    await this.ref(`telemetry/${deviceId}/latest`).set(packet);
  }

  async saveHistory(deviceId: string, packet: TelemetryPacket): Promise<void> {
    await this.ref(`telemetry/${deviceId}/history`).push(packet);
  }

  async getLatest(deviceId: string): Promise<TelemetryPacket | null> {
    const snapshot = await this.ref(`telemetry/${deviceId}/latest`).get();
    return snapshot.exists() ? snapshot.val() as TelemetryPacket : null;
  }

  async getHistory(deviceId: string, start: number, end: number, limit: number): Promise<Array<TelemetryPacket & { id: string }>> {
    const snapshot = await this.ref(`telemetry/${deviceId}/history`).orderByChild('timestamp').startAt(start).endAt(end - 1).limitToLast(limit).get();
    if (!snapshot.exists()) return [];
    return Object.entries(snapshot.val() as Record<string, TelemetryPacket>)
      .map(([id, value]) => ({ ...value, id }))
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  }
}

export function parameterMap(parameters: Parameter[]): Record<string, Parameter> {
  return Object.fromEntries(parameters.map((parameter) => [parameter.id, parameter]));
}

export function validateTelemetryParameters(values: Record<string, SensorValue>, parameters: Record<string, Parameter>): boolean {
  const ids = Object.keys(values);
  return ids.length === Object.keys(parameters).length && ids.every((id) => id in parameters);
}
