import { Database as SqliteDatabase } from 'bun:sqlite';
import { and, asc, desc, eq, gte, gt, lt, lte, sql } from 'drizzle-orm';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';
import type {
  Device,
  EncryptedSecret,
  LocalUser,
  Parameter,
  SensorValue,
  SessionUser,
  TelemetryPacket,
} from './types.js';

const CURRENT_SCHEMA_VERSION = 3;
type DrizzleDatabase = BunSQLiteDatabase<typeof schema>;
type StoredDevice = typeof schema.devices.$inferSelect;
type StoredUser = typeof schema.users.$inferSelect;
type StoredTelemetry = typeof schema.telemetry.$inferSelect;

export type LegacyMetadataImport = {
  devices: Record<string, Device>;
  access: Record<
    string,
    { ownerUid: string; active: boolean; credentialVersion: number }
  >;
  secrets: Record<string, EncryptedSecret>;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function databaseVersion(sqlite: SqliteDatabase): number {
  const row = sqlite.query('PRAGMA user_version').get() as {
    user_version: number;
  };
  return row.user_version;
}

export function backupDatabase(path: string): string | null {
  if (path === ':memory:' || !existsSync(path)) return null;
  const backupPath = `${path}.backup-${new Date().toISOString().replaceAll(':', '-')}`;
  copyFileSync(path, backupPath);
  chmodSync(backupPath, 0o600);
  return backupPath;
}

// Existing deployments are versioned by PRAGMA user_version. These DDL migrations
// intentionally remain authoritative; Drizzle is used for application queries and
// must never schema-push a populated database.
function migrate(sqlite: SqliteDatabase): void {
  let version = databaseVersion(sqlite);
  if (version > CURRENT_SCHEMA_VERSION)
    throw new Error(
      `SQLite schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    );
  if (version < 1) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, label TEXT NOT NULL, active INTEGER NOT NULL CHECK (active IN (0, 1)), credential_version INTEGER NOT NULL CHECK (credential_version > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, parameters_json TEXT NOT NULL, secret_iv TEXT NOT NULL, secret_ciphertext TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS devices_owner_uid ON devices(owner_uid);
      CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    version = 1;
  }
  if (version < 2) {
    sqlite.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL CHECK (active IN (0, 1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
      CREATE INDEX sessions_user_id ON sessions(user_id); CREATE INDEX sessions_expires_at ON sessions(expires_at);
      CREATE TABLE owner_links (legacy_uid TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, linked_at INTEGER NOT NULL);
      PRAGMA user_version = 2;
    `);
    version = 2;
  }
  if (version < 3)
    sqlite.exec(`
    CREATE TABLE telemetry (device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, write_id TEXT NOT NULL, timestamp INTEGER NOT NULL, credential_version INTEGER NOT NULL, values_json TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (device_id, write_id));
    CREATE INDEX telemetry_device_time ON telemetry(device_id, timestamp DESC, write_id DESC);
    CREATE TABLE telemetry_latest (device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE, write_id TEXT NOT NULL, timestamp INTEGER NOT NULL, credential_version INTEGER NOT NULL, values_json TEXT NOT NULL, received_at INTEGER NOT NULL);
    PRAGMA user_version = 3;
  `);
}

export function openDatabase(
  path: string,
  options: { migrate?: boolean; backup?: boolean } = {},
): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const existed = path !== ':memory:' && existsSync(path);
  const sqlite = new SqliteDatabase(path, { create: true, strict: true });
  sqlite.exec(
    'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;',
  );
  if (path !== ':memory:') chmodSync(path, 0o600);
  if (options.migrate !== false) {
    const needsMigration = databaseVersion(sqlite) < CURRENT_SCHEMA_VERSION;
    if (existed && needsMigration && options.backup !== false)
      backupDatabase(path);
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      migrate(sqlite);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      sqlite.close();
      throw error;
    }
  }
  return sqlite;
}

export const openMetadataDatabase = openDatabase;
export function assertMetadataMigrated(sqlite: SqliteDatabase): void {
  if (databaseVersion(sqlite) < CURRENT_SCHEMA_VERSION)
    throw new Error('SQLite database migrations are incomplete');
}

function deviceToRow(
  device: Device,
  secret: EncryptedSecret,
): typeof schema.devices.$inferInsert {
  return {
    id: device.id,
    ownerUid: device.ownerUid,
    label: device.label,
    active: device.active ? 1 : 0,
    credentialVersion: device.credentialVersion,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    parameters: device.parameters,
    secretIv: secret.iv,
    secretCiphertext: secret.ciphertext,
  };
}
function rowToDevice(row: StoredDevice): Device {
  return {
    id: row.id,
    ownerUid: row.ownerUid,
    label: row.label,
    active: row.active === 1,
    credentialVersion: row.credentialVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    parameters: row.parameters,
  };
}
function rowToPacket(
  row: StoredTelemetry | typeof schema.telemetryLatest.$inferSelect,
): TelemetryPacket {
  return {
    timestamp: row.timestamp,
    writeId: row.writeId,
    credentialVersion: row.credentialVersion,
    values: row.values,
  };
}
function publicUser(row: StoredUser): LocalUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    active: row.active === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class Repository {
  private readonly db: DrizzleDatabase;
  private readonly getDeviceStatement;
  private readonly listDevicesStatement;
  private readonly getSecretStatement;
  private readonly insertTelemetryStatement;
  private readonly getTelemetryLatestStatement;
  private readonly upsertTelemetryLatestStatement;

  constructor(private readonly sqlite: SqliteDatabase) {
    this.db = drizzle({ client: sqlite, schema });
    this.getDeviceStatement = this.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, sql.placeholder('id')))
      .prepare();
    this.listDevicesStatement = this.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.ownerUid, sql.placeholder('ownerUid')))
      .orderBy(asc(schema.devices.createdAt), asc(schema.devices.id))
      .prepare();
    this.getSecretStatement = this.db
      .select({
        iv: schema.devices.secretIv,
        ciphertext: schema.devices.secretCiphertext,
      })
      .from(schema.devices)
      .where(eq(schema.devices.id, sql.placeholder('id')))
      .prepare();
    this.insertTelemetryStatement = this.db
      .insert(schema.telemetry)
      .values({
        deviceId: sql.placeholder('deviceId'),
        writeId: sql.placeholder('writeId'),
        timestamp: sql.placeholder('timestamp'),
        credentialVersion: sql.placeholder('credentialVersion'),
        values: sql.placeholder('values'),
        receivedAt: sql.placeholder('receivedAt'),
      })
      .onConflictDoNothing()
      .returning({ deviceId: schema.telemetry.deviceId })
      .prepare();
    this.getTelemetryLatestStatement = this.db
      .select({
        timestamp: schema.telemetryLatest.timestamp,
        writeId: schema.telemetryLatest.writeId,
      })
      .from(schema.telemetryLatest)
      .where(eq(schema.telemetryLatest.deviceId, sql.placeholder('deviceId')))
      .prepare();
    this.upsertTelemetryLatestStatement = this.db
      .insert(schema.telemetryLatest)
      .values({
        deviceId: sql.placeholder('deviceId'),
        writeId: sql.placeholder('writeId'),
        timestamp: sql.placeholder('timestamp'),
        credentialVersion: sql.placeholder('credentialVersion'),
        values: sql.placeholder('values'),
        receivedAt: sql.placeholder('receivedAt'),
      })
      .onConflictDoUpdate({
        target: schema.telemetryLatest.deviceId,
        set: {
          writeId: sql`excluded.write_id`,
          timestamp: sql`excluded.timestamp`,
          credentialVersion: sql`excluded.credential_version`,
          values: sql`excluded.values_json`,
          receivedAt: sql`excluded.received_at`,
        },
      })
      .prepare();
  }

  close(): void {
    this.sqlite.close();
  }
  getDevice(deviceId: string): Device | null {
    const row = this.getDeviceStatement.get({ id: deviceId });
    return row ? rowToDevice(row) : null;
  }
  listDevices(ownerUid: string): Device[] {
    return this.listDevicesStatement.all({ ownerUid }).map(rowToDevice);
  }
  listAllDevices(): Device[] {
    return this.db
      .select()
      .from(schema.devices)
      .orderBy(asc(schema.devices.id))
      .all()
      .map(rowToDevice);
  }
  getEncryptedSecret(deviceId: string): EncryptedSecret | null {
    return this.getSecretStatement.get({ id: deviceId }) ?? null;
  }

  private writeDevice(device: Device, secret: EncryptedSecret): void {
    const row = deviceToRow(device, secret);
    this.db
      .insert(schema.devices)
      .values(row)
      .onConflictDoUpdate({
        target: schema.devices.id,
        set: {
          ownerUid: row.ownerUid,
          label: row.label,
          active: row.active,
          credentialVersion: row.credentialVersion,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          parameters: row.parameters,
          secretIv: row.secretIv,
          secretCiphertext: row.secretCiphertext,
        },
      })
      .run();
  }
  saveDeviceBundle(device: Device, secret: EncryptedSecret): void {
    if (this.getDevice(device.id))
      throw new Error(`Device ${device.id} already exists`);
    this.writeDevice(device, secret);
  }
  updateDevice(
    deviceId: string,
    patch: Partial<Device>,
    secret?: EncryptedSecret,
  ): Device {
    const current = this.getDevice(deviceId);
    if (!current) throw new Error(`Device ${deviceId} not found`);
    const encrypted = secret ?? this.getEncryptedSecret(deviceId);
    if (!encrypted)
      throw new Error(`Device secret unavailable for ${deviceId}`);
    const updated = { ...current, ...patch };
    this.writeDevice(updated, encrypted);
    return updated;
  }
  deleteDevice(deviceId: string): void {
    this.db.delete(schema.devices).where(eq(schema.devices.id, deviceId)).run();
  }

  saveTelemetry(
    deviceId: string,
    packet: TelemetryPacket,
    receivedAt = Date.now(),
  ): { inserted: boolean; latestChanged: boolean } {
    return this.db.transaction(() => {
      const values = packet.values;
      const insert = this.insertTelemetryStatement.all({
        deviceId,
        writeId: packet.writeId,
        timestamp: packet.timestamp,
        credentialVersion: packet.credentialVersion,
        values,
        receivedAt,
      });
      if (insert.length === 0) return { inserted: false, latestChanged: false };
      const latest = this.getTelemetryLatestStatement.get({ deviceId });
      const latestChanged =
        !latest ||
        packet.timestamp > latest.timestamp ||
        (packet.timestamp === latest.timestamp &&
          packet.writeId > latest.writeId);
      if (latestChanged)
        this.upsertTelemetryLatestStatement.run({
          deviceId,
          writeId: packet.writeId,
          timestamp: packet.timestamp,
          credentialVersion: packet.credentialVersion,
          values,
          receivedAt,
        });
      return { inserted: true, latestChanged };
    });
  }
  getLatest(deviceId: string): TelemetryPacket | null {
    const row = this.db
      .select()
      .from(schema.telemetryLatest)
      .where(eq(schema.telemetryLatest.deviceId, deviceId))
      .get();
    return row ? rowToPacket(row) : null;
  }
  getRecent(deviceId: string, limit = 10): TelemetryPacket[] {
    return this.db
      .select()
      .from(schema.telemetry)
      .where(eq(schema.telemetry.deviceId, deviceId))
      .orderBy(desc(schema.telemetry.timestamp), desc(schema.telemetry.writeId))
      .limit(limit)
      .all()
      .reverse()
      .map(rowToPacket);
  }
  getHistory(
    deviceId: string,
    start: number,
    end: number,
    limit: number,
  ): TelemetryPacket[] {
    return this.db
      .select()
      .from(schema.telemetry)
      .where(
        and(
          eq(schema.telemetry.deviceId, deviceId),
          gte(schema.telemetry.timestamp, start),
          lt(schema.telemetry.timestamp, end),
        ),
      )
      .orderBy(desc(schema.telemetry.timestamp), desc(schema.telemetry.writeId))
      .limit(limit)
      .all()
      .reverse()
      .map(rowToPacket);
  }
  pruneTelemetry(cutoff: number, deviceId?: string): number {
    return this.db.transaction(
      () =>
        this.db
          .delete(schema.telemetry)
          .where(
            deviceId
              ? and(
                  eq(schema.telemetry.deviceId, deviceId),
                  lt(schema.telemetry.timestamp, cutoff),
                )
              : lt(schema.telemetry.timestamp, cutoff),
          )
          .returning({ deviceId: schema.telemetry.deviceId })
          .all().length,
    );
  }

  createUser(user: LocalUser, passwordHash: string): void {
    this.db
      .insert(schema.users)
      .values({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        passwordHash,
        active: user.active ? 1 : 0,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })
      .run();
  }
  getUserByUsername(
    username: string,
  ): (LocalUser & { passwordHash: string }) | null {
    const row = this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, username))
      .get();
    return row ? { ...publicUser(row), passwordHash: row.passwordHash } : null;
  }
  getUserById(id: string): LocalUser | null {
    const row = this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .get();
    return row ? publicUser(row) : null;
  }
  deleteUser(id: string): void {
    this.db.delete(schema.users).where(eq(schema.users.id, id)).run();
  }
  countUsers(): number {
    return this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.users)
      .get()!.count;
  }
  createSession(
    idHash: string,
    userId: string,
    csrfHash: string,
    now: number,
    expiresAt: number,
  ): void {
    this.db
      .insert(schema.sessions)
      .values({
        idHash,
        userId,
        csrfHash,
        createdAt: now,
        expiresAt,
        lastSeenAt: now,
      })
      .run();
  }
  getSession(
    idHash: string,
    now: number,
  ): { user: SessionUser; csrfHash: string; expiresAt: number } | null {
    const row = this.db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        csrfHash: schema.sessions.csrfHash,
        expiresAt: schema.sessions.expiresAt,
      })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(
        and(
          eq(schema.sessions.idHash, idHash),
          gt(schema.sessions.expiresAt, now),
          eq(schema.users.active, 1),
        ),
      )
      .get();
    if (!row) return null;
    this.db
      .update(schema.sessions)
      .set({ lastSeenAt: now })
      .where(eq(schema.sessions.idHash, idHash))
      .run();
    return {
      user: {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
      },
      csrfHash: row.csrfHash,
      expiresAt: row.expiresAt,
    };
  }
  deleteSession(idHash: string): void {
    this.db
      .delete(schema.sessions)
      .where(eq(schema.sessions.idHash, idHash))
      .run();
  }
  deleteExpiredSessions(now: number): number {
    return this.db
      .delete(schema.sessions)
      .where(lte(schema.sessions.expiresAt, now))
      .returning({ idHash: schema.sessions.idHash })
      .all().length;
  }
  revokeUserSessions(userId: string): number {
    return this.db
      .delete(schema.sessions)
      .where(eq(schema.sessions.userId, userId))
      .returning({ idHash: schema.sessions.idHash })
      .all().length;
  }
  linkLegacyOwner(legacyUid: string, userId: string): number {
    return this.db.transaction(() => {
      const existing = this.db
        .select({ userId: schema.ownerLinks.userId })
        .from(schema.ownerLinks)
        .where(eq(schema.ownerLinks.legacyUid, legacyUid))
        .get();
      if (existing && existing.userId !== userId)
        throw new Error('Legacy owner UID is already linked to another user');
      this.db
        .insert(schema.ownerLinks)
        .values({ legacyUid, userId, linkedAt: Date.now() })
        .onConflictDoNothing()
        .run();
      return this.db
        .update(schema.devices)
        .set({ ownerUid: userId, updatedAt: Date.now() })
        .where(eq(schema.devices.ownerUid, legacyUid))
        .returning({ id: schema.devices.id })
        .all().length;
    });
  }
}

function validateImportBundle(
  id: string,
  device: Device,
  access: LegacyMetadataImport['access'][string],
  secret: EncryptedSecret,
): void {
  const validParameter = (parameterId: string, value: Parameter) =>
    value &&
    value.id === parameterId &&
    typeof value.label === 'string' &&
    typeof value.unit === 'string' &&
    Number.isInteger(value.points) &&
    value.points >= 0 &&
    value.points <= 10;
  if (
    !device ||
    device.id !== id ||
    typeof device.ownerUid !== 'string' ||
    !device.ownerUid ||
    typeof device.label !== 'string' ||
    typeof device.active !== 'boolean' ||
    !Number.isInteger(device.credentialVersion) ||
    device.credentialVersion < 1 ||
    !Number.isSafeInteger(device.createdAt) ||
    !Number.isSafeInteger(device.updatedAt) ||
    !device.parameters ||
    Object.entries(device.parameters).some(
      ([parameterId, value]) => !validParameter(parameterId, value),
    )
  )
    throw new Error(`Invalid device metadata for ${id}`);
  if (
    !access ||
    device.ownerUid !== access.ownerUid ||
    device.active !== access.active ||
    device.credentialVersion !== access.credentialVersion ||
    !secret?.iv ||
    !secret.ciphertext
  )
    throw new Error(`Invalid access or encrypted secret for ${id}`);
}

export function importLegacyMetadata(
  sqlite: SqliteDatabase,
  input: LegacyMetadataImport,
  allowEmpty = false,
): { devices: number; inserted: number; unchanged: number } {
  const ids = Object.keys(input.devices).sort();
  if (!allowEmpty && ids.length === 0)
    throw new Error(
      'Legacy metadata is empty; pass --allow-empty to acknowledge',
    );
  if (
    stableJson(ids) !== stableJson(Object.keys(input.access).sort()) ||
    stableJson(ids) !== stableJson(Object.keys(input.secrets).sort())
  )
    throw new Error('Legacy metadata is incomplete');
  const db = drizzle({ client: sqlite, schema });
  let inserted = 0;
  let unchanged = 0;
  db.transaction(() => {
    for (const id of ids) {
      const device = input.devices[id]!;
      const access = input.access[id]!;
      const secret = input.secrets[id]!;
      validateImportBundle(id, device, access, secret);
      const existing = db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, id))
        .get();
      const incoming = deviceToRow(device, secret);
      if (existing) {
        if (stableJson(existing) !== stableJson(incoming))
          throw new Error(
            `SQLite conflict for existing device ${id}; refusing to overwrite`,
          );
        unchanged++;
        continue;
      }
      db.insert(schema.devices).values(incoming).run();
      inserted++;
    }
  });
  return { devices: ids.length, inserted, unchanged };
}

export const importMetadata = importLegacyMetadata;
export function metadataCounts(sqlite: SqliteDatabase): {
  devices: number;
  secrets: number;
  owners: number;
  parameters: number;
} {
  const rows = drizzle({ client: sqlite, schema })
    .select()
    .from(schema.devices)
    .all();
  return {
    devices: rows.length,
    secrets: rows.filter((row) => row.secretIv && row.secretCiphertext).length,
    owners: new Set(rows.map((row) => row.ownerUid)).size,
    parameters: rows.reduce(
      (sum, row) => sum + Object.keys(row.parameters).length,
      0,
    ),
  };
}
export function listMetadataDeviceIds(sqlite: SqliteDatabase): string[] {
  return drizzle({ client: sqlite, schema })
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .orderBy(asc(schema.devices.id))
    .all()
    .map(({ id }) => id);
}
export function parameterMap(
  parameters: Parameter[],
): Record<string, Parameter> {
  return Object.fromEntries(
    parameters.map((parameter) => [parameter.id, parameter]),
  );
}
export function validateTelemetryParameters(
  values: Record<string, SensorValue>,
  parameters: Record<string, Parameter>,
): boolean {
  const ids = Object.keys(values);
  return (
    ids.length === Object.keys(parameters).length &&
    ids.every((id) => id in parameters)
  );
}
