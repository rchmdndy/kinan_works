import { Database as SqliteDatabase } from 'bun:sqlite';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Device, EncryptedSecret, LocalUser, Parameter, SensorValue, SessionUser, TelemetryPacket } from './types.js';

const CURRENT_SCHEMA_VERSION = 3;
const rowColumns = 'id, owner_uid, label, active, credential_version, created_at, updated_at, parameters_json, secret_iv, secret_ciphertext';

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

type StoredUser = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  active: number;
  created_at: number;
  updated_at: number;
};

type StoredTelemetry = {
  device_id: string;
  write_id: string;
  timestamp: number;
  credential_version: number;
  values_json: string;
};

export type LegacyMetadataImport = {
  devices: Record<string, Device>;
  access: Record<string, { ownerUid: string; active: boolean; credentialVersion: number }>;
  secrets: Record<string, EncryptedSecret>;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

function databaseVersion(sqlite: SqliteDatabase): number {
  const row = sqlite.query('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

export function backupDatabase(path: string): string | null {
  if (path === ':memory:' || !existsSync(path)) return null;
  const backupPath = `${path}.backup-${new Date().toISOString().replaceAll(':', '-')}`;
  copyFileSync(path, backupPath);
  chmodSync(backupPath, 0o600);
  return backupPath;
}

function migrate(sqlite: SqliteDatabase): void {
  let version = databaseVersion(sqlite);
  if (version > CURRENT_SCHEMA_VERSION) throw new Error(`SQLite schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`);

  if (version < 1) {
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
      CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    version = 1;
  }
  if (version < 2) {
    sqlite.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_user_id ON sessions(user_id);
      CREATE INDEX sessions_expires_at ON sessions(expires_at);
      CREATE TABLE owner_links (
        legacy_uid TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        linked_at INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
    `);
    version = 2;
  }
  if (version < 3) {
    sqlite.exec(`
      CREATE TABLE telemetry (
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        write_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        credential_version INTEGER NOT NULL,
        values_json TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, write_id)
      );
      CREATE INDEX telemetry_device_time ON telemetry(device_id, timestamp DESC, write_id DESC);
      CREATE TABLE telemetry_latest (
        device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
        write_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        credential_version INTEGER NOT NULL,
        values_json TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      PRAGMA user_version = 3;
    `);
  }
}

export function openDatabase(path: string, options: { migrate?: boolean; backup?: boolean } = {}): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const existed = path !== ':memory:' && existsSync(path);
  const sqlite = new SqliteDatabase(path, { create: true, strict: true });
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  if (path !== ':memory:') chmodSync(path, 0o600);
  if (options.migrate !== false) {
    const needsMigration = databaseVersion(sqlite) < CURRENT_SCHEMA_VERSION;
    if (existed && needsMigration && options.backup !== false) backupDatabase(path);
    sqlite.exec('BEGIN IMMEDIATE');
    try { migrate(sqlite); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); sqlite.close(); throw error; }
  }
  return sqlite;
}

export const openMetadataDatabase = openDatabase;
export function assertMetadataMigrated(sqlite: SqliteDatabase): void {
  if (databaseVersion(sqlite) < CURRENT_SCHEMA_VERSION) throw new Error('SQLite database migrations are incomplete');
}

function deviceToRow(device: Device, secret: EncryptedSecret): StoredDevice {
  return { id: device.id, owner_uid: device.ownerUid, label: device.label, active: device.active ? 1 : 0, credential_version: device.credentialVersion, created_at: device.createdAt, updated_at: device.updatedAt, parameters_json: stableJson(device.parameters), secret_iv: secret.iv, secret_ciphertext: secret.ciphertext };
}

function rowToDevice(row: StoredDevice): Device {
  return { id: row.id, ownerUid: row.owner_uid, label: row.label, active: row.active === 1, credentialVersion: row.credential_version, createdAt: row.created_at, updatedAt: row.updated_at, parameters: JSON.parse(row.parameters_json) as Record<string, Parameter> };
}

function rowToPacket(row: StoredTelemetry): TelemetryPacket {
  return { timestamp: row.timestamp, writeId: row.write_id, credentialVersion: row.credential_version, values: JSON.parse(row.values_json) as Record<string, SensorValue> };
}

function publicUser(row: StoredUser): LocalUser {
  return { id: row.id, username: row.username, displayName: row.display_name, active: row.active === 1, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class Repository {
  constructor(private readonly sqlite: SqliteDatabase) {}

  close(): void { this.sqlite.close(); }

  getDevice(deviceId: string): Device | null {
    const row = this.sqlite.query(`SELECT ${rowColumns} FROM devices WHERE id = ?`).get(deviceId) as StoredDevice | null;
    return row ? rowToDevice(row) : null;
  }

  listDevices(ownerUid: string): Device[] {
    return (this.sqlite.query(`SELECT ${rowColumns} FROM devices WHERE owner_uid = ? ORDER BY created_at, id`).all(ownerUid) as StoredDevice[]).map(rowToDevice);
  }

  listAllDevices(): Device[] {
    return (this.sqlite.query(`SELECT ${rowColumns} FROM devices ORDER BY id`).all() as StoredDevice[]).map(rowToDevice);
  }

  getEncryptedSecret(deviceId: string): EncryptedSecret | null {
    const row = this.sqlite.query('SELECT secret_iv, secret_ciphertext FROM devices WHERE id = ?').get(deviceId) as Pick<StoredDevice, 'secret_iv' | 'secret_ciphertext'> | null;
    return row ? { iv: row.secret_iv, ciphertext: row.secret_ciphertext } : null;
  }

  private writeDevice(device: Device, secret: EncryptedSecret): void {
    const row = deviceToRow(device, secret);
    this.sqlite.query(`INSERT INTO devices (${rowColumns}) VALUES ($id,$owner_uid,$label,$active,$credential_version,$created_at,$updated_at,$parameters_json,$secret_iv,$secret_ciphertext)
      ON CONFLICT(id) DO UPDATE SET owner_uid=$owner_uid,label=$label,active=$active,credential_version=$credential_version,created_at=$created_at,updated_at=$updated_at,parameters_json=$parameters_json,secret_iv=$secret_iv,secret_ciphertext=$secret_ciphertext`).run(row);
  }

  saveDeviceBundle(device: Device, secret: EncryptedSecret): void {
    if (this.getDevice(device.id)) throw new Error(`Device ${device.id} already exists`);
    this.writeDevice(device, secret);
  }

  updateDevice(deviceId: string, patch: Partial<Device>, secret?: EncryptedSecret): Device {
    const current = this.getDevice(deviceId);
    if (!current) throw new Error(`Device ${deviceId} not found`);
    const encrypted = secret ?? this.getEncryptedSecret(deviceId);
    if (!encrypted) throw new Error(`Device secret unavailable for ${deviceId}`);
    const updated = { ...current, ...patch };
    this.writeDevice(updated, encrypted);
    return updated;
  }

  deleteDevice(deviceId: string): void { this.sqlite.query('DELETE FROM devices WHERE id = ?').run(deviceId); }

  saveTelemetry(deviceId: string, packet: TelemetryPacket, receivedAt = Date.now()): { inserted: boolean; latestChanged: boolean } {
    const execute = this.sqlite.transaction(() => {
      const valuesJson = stableJson(packet.values);
      const insert = this.sqlite.query('INSERT OR IGNORE INTO telemetry (device_id,write_id,timestamp,credential_version,values_json,received_at) VALUES (?,?,?,?,?,?)').run(deviceId, packet.writeId, packet.timestamp, packet.credentialVersion, valuesJson, receivedAt);
      if (insert.changes === 0) return { inserted: false, latestChanged: false };
      const latest = this.sqlite.query('SELECT timestamp, write_id FROM telemetry_latest WHERE device_id = ?').get(deviceId) as { timestamp: number; write_id: string } | null;
      const latestChanged = !latest || packet.timestamp > latest.timestamp || (packet.timestamp === latest.timestamp && packet.writeId > latest.write_id);
      if (latestChanged) this.sqlite.query(`INSERT INTO telemetry_latest (device_id,write_id,timestamp,credential_version,values_json,received_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET write_id=excluded.write_id,timestamp=excluded.timestamp,credential_version=excluded.credential_version,values_json=excluded.values_json,received_at=excluded.received_at`).run(deviceId, packet.writeId, packet.timestamp, packet.credentialVersion, valuesJson, receivedAt);
      return { inserted: true, latestChanged };
    });
    return execute();
  }

  getLatest(deviceId: string): TelemetryPacket | null {
    const row = this.sqlite.query('SELECT device_id,write_id,timestamp,credential_version,values_json FROM telemetry_latest WHERE device_id = ?').get(deviceId) as StoredTelemetry | null;
    return row ? rowToPacket(row) : null;
  }

  getRecent(deviceId: string, limit = 10): TelemetryPacket[] {
    const rows = this.sqlite.query('SELECT device_id,write_id,timestamp,credential_version,values_json FROM telemetry WHERE device_id = ? ORDER BY timestamp DESC, write_id DESC LIMIT ?').all(deviceId, limit) as StoredTelemetry[];
    return rows.reverse().map(rowToPacket);
  }

  getHistory(deviceId: string, start: number, end: number, limit: number): TelemetryPacket[] {
    const rows = this.sqlite.query('SELECT device_id,write_id,timestamp,credential_version,values_json FROM telemetry WHERE device_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp DESC, write_id DESC LIMIT ?').all(deviceId, start, end, limit) as StoredTelemetry[];
    return rows.reverse().map(rowToPacket);
  }

  pruneTelemetry(cutoff: number, deviceId?: string): number {
    const execute = this.sqlite.transaction(() => {
      const result = deviceId ? this.sqlite.query('DELETE FROM telemetry WHERE device_id = ? AND timestamp < ?').run(deviceId, cutoff) : this.sqlite.query('DELETE FROM telemetry WHERE timestamp < ?').run(cutoff);
      return Number(result.changes);
    });
    return execute();
  }

  createUser(user: LocalUser, passwordHash: string): void {
    this.sqlite.query('INSERT INTO users (id,username,display_name,password_hash,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(user.id, user.username, user.displayName, passwordHash, user.active ? 1 : 0, user.createdAt, user.updatedAt);
  }

  getUserByUsername(username: string): (LocalUser & { passwordHash: string }) | null {
    const row = this.sqlite.query('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as StoredUser | null;
    return row ? { ...publicUser(row), passwordHash: row.password_hash } : null;
  }

  getUserById(id: string): LocalUser | null {
    const row = this.sqlite.query('SELECT * FROM users WHERE id = ?').get(id) as StoredUser | null;
    return row ? publicUser(row) : null;
  }

  countUsers(): number { return (this.sqlite.query('SELECT COUNT(*) count FROM users').get() as { count: number }).count; }

  createSession(idHash: string, userId: string, csrfHash: string, now: number, expiresAt: number): void {
    this.sqlite.query('INSERT INTO sessions (id_hash,user_id,csrf_hash,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?,?)').run(idHash, userId, csrfHash, now, expiresAt, now);
  }

  getSession(idHash: string, now: number): { user: SessionUser; csrfHash: string; expiresAt: number } | null {
    const row = this.sqlite.query(`SELECT u.id,u.username,u.display_name,s.csrf_hash,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>? AND u.active=1`).get(idHash, now) as { id: string; username: string; display_name: string; csrf_hash: string; expires_at: number } | null;
    if (!row) return null;
    this.sqlite.query('UPDATE sessions SET last_seen_at=? WHERE id_hash=?').run(now, idHash);
    return { user: { id: row.id, username: row.username, displayName: row.display_name }, csrfHash: row.csrf_hash, expiresAt: row.expires_at };
  }

  deleteSession(idHash: string): void { this.sqlite.query('DELETE FROM sessions WHERE id_hash = ?').run(idHash); }
  deleteExpiredSessions(now: number): number { return Number(this.sqlite.query('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes); }
  revokeUserSessions(userId: string): number { return Number(this.sqlite.query('DELETE FROM sessions WHERE user_id = ?').run(userId).changes); }

  linkLegacyOwner(legacyUid: string, userId: string): number {
    const run = this.sqlite.transaction(() => {
      const existing = this.sqlite.query('SELECT user_id FROM owner_links WHERE legacy_uid = ?').get(legacyUid) as { user_id: string } | null;
      if (existing && existing.user_id !== userId) throw new Error('Legacy owner UID is already linked to another user');
      this.sqlite.query('INSERT INTO owner_links (legacy_uid,user_id,linked_at) VALUES (?,?,?) ON CONFLICT(legacy_uid) DO NOTHING').run(legacyUid, userId, Date.now());
      const result = this.sqlite.query('UPDATE devices SET owner_uid=?, updated_at=? WHERE owner_uid=?').run(userId, Date.now(), legacyUid);
      return Number(result.changes);
    });
    return run();
  }
}

function validateImportBundle(id: string, device: Device, access: LegacyMetadataImport['access'][string], secret: EncryptedSecret): void {
  const validParameter = (parameterId: string, value: Parameter) => value && value.id === parameterId && typeof value.label === 'string' && typeof value.unit === 'string' && Number.isInteger(value.points) && value.points >= 0 && value.points <= 10;
  if (!device || device.id !== id || typeof device.ownerUid !== 'string' || !device.ownerUid || typeof device.label !== 'string' || typeof device.active !== 'boolean' || !Number.isInteger(device.credentialVersion) || device.credentialVersion < 1 || !Number.isSafeInteger(device.createdAt) || !Number.isSafeInteger(device.updatedAt) || !device.parameters || Object.entries(device.parameters).some(([parameterId, value]) => !validParameter(parameterId, value))) throw new Error(`Invalid device metadata for ${id}`);
  if (!access || device.ownerUid !== access.ownerUid || device.active !== access.active || device.credentialVersion !== access.credentialVersion || !secret?.iv || !secret.ciphertext) throw new Error(`Invalid access or encrypted secret for ${id}`);
}

export function importLegacyMetadata(sqlite: SqliteDatabase, input: LegacyMetadataImport, allowEmpty = false): { devices: number; inserted: number; unchanged: number } {
  const ids = Object.keys(input.devices).sort();
  if (!allowEmpty && ids.length === 0) throw new Error('Legacy metadata is empty; pass --allow-empty to acknowledge');
  if (stableJson(ids) !== stableJson(Object.keys(input.access).sort()) || stableJson(ids) !== stableJson(Object.keys(input.secrets).sort())) throw new Error('Legacy metadata is incomplete');
  let inserted = 0; let unchanged = 0;
  const run = sqlite.transaction(() => {
    for (const id of ids) {
      const device = input.devices[id]!; const access = input.access[id]!; const secret = input.secrets[id]!;
      validateImportBundle(id, device, access, secret);
      const existing = sqlite.query(`SELECT ${rowColumns} FROM devices WHERE id=?`).get(id) as StoredDevice | null;
      const incoming = deviceToRow(device, secret);
      if (existing) {
        if (stableJson(existing) !== stableJson(incoming)) throw new Error(`SQLite conflict for existing device ${id}; refusing to overwrite`);
        unchanged++; continue;
      }
      sqlite.query(`INSERT INTO devices (${rowColumns}) VALUES ($id,$owner_uid,$label,$active,$credential_version,$created_at,$updated_at,$parameters_json,$secret_iv,$secret_ciphertext)`).run(incoming);
      inserted++;
    }
  });
  run();
  return { devices: ids.length, inserted, unchanged };
}

export const importMetadata = importLegacyMetadata;
export function metadataCounts(sqlite: SqliteDatabase): { devices: number; secrets: number; owners: number; parameters: number } {
  const rows = sqlite.query(`SELECT ${rowColumns} FROM devices`).all() as StoredDevice[];
  return { devices: rows.length, secrets: rows.filter((row) => row.secret_iv && row.secret_ciphertext).length, owners: new Set(rows.map((row) => row.owner_uid)).size, parameters: rows.reduce((sum, row) => sum + Object.keys(JSON.parse(row.parameters_json) as object).length, 0) };
}
export function listMetadataDeviceIds(sqlite: SqliteDatabase): string[] { return (sqlite.query('SELECT id FROM devices ORDER BY id').all() as Array<{ id: string }>).map(({ id }) => id); }
export function parameterMap(parameters: Parameter[]): Record<string, Parameter> { return Object.fromEntries(parameters.map((parameter) => [parameter.id, parameter])); }
export function validateTelemetryParameters(values: Record<string, SensorValue>, parameters: Record<string, Parameter>): boolean {
  const ids = Object.keys(values);
  return ids.length === Object.keys(parameters).length && ids.every((id) => id in parameters);
}
