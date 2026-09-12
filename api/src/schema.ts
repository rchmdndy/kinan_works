import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type { Parameter, SensorValue } from './types.js';

// This schema describes the versioned SQLite database. The hand-written
// migrations in repository.ts remain authoritative for existing installations.
export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    ownerUid: text('owner_uid').notNull(),
    label: text('label').notNull(),
    active: integer('active').notNull(),
    credentialVersion: integer('credential_version').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    parameters: text('parameters_json', { mode: 'json' })
      .$type<Record<string, Parameter>>()
      .notNull(),
    secretIv: text('secret_iv').notNull(),
    secretCiphertext: text('secret_ciphertext').notNull(),
  },
  (table) => [index('devices_owner_uid').on(table.ownerUid)],
);

export const appMetadata = sqliteTable('app_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  // The deployed table declares COLLATE NOCASE and UNIQUE. Keep that database
  // constraint intact; this schema is descriptive and is never pushed.
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  active: integer('active').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfHash: text('csrf_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (table) => [
    index('sessions_user_id').on(table.userId),
    index('sessions_expires_at').on(table.expiresAt),
  ],
);

export const ownerLinks = sqliteTable('owner_links', {
  legacyUid: text('legacy_uid').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  linkedAt: integer('linked_at').notNull(),
});

export const telemetry = sqliteTable(
  'telemetry',
  {
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    writeId: text('write_id').notNull(),
    timestamp: integer('timestamp').notNull(),
    credentialVersion: integer('credential_version').notNull(),
    values: text('values_json', { mode: 'json' })
      .$type<Record<string, SensorValue>>()
      .notNull(),
    receivedAt: integer('received_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.writeId] }),
    index('telemetry_device_time').on(
      table.deviceId,
      sql`${table.timestamp} DESC`,
      sql`${table.writeId} DESC`,
    ),
  ],
);

export const telemetryLatest = sqliteTable('telemetry_latest', {
  deviceId: text('device_id')
    .primaryKey()
    .references(() => devices.id, { onDelete: 'cascade' }),
  writeId: text('write_id').notNull(),
  timestamp: integer('timestamp').notNull(),
  credentialVersion: integer('credential_version').notNull(),
  values: text('values_json', { mode: 'json' })
    .$type<Record<string, SensorValue>>()
    .notNull(),
  receivedAt: integer('received_at').notNull(),
});

export const deviceControl = sqliteTable('device_control', {
  deviceId: text('device_id')
    .primaryKey()
    .references(() => devices.id, { onDelete: 'cascade' }),
  state: text('state_json', { mode: 'json' }).$type<
    import('./control-contract.js').DeviceState
  >(),
  availability: text('availability_json', { mode: 'json' }).$type<
    import('./control-contract.js').Availability
  >(),
});
export const deviceCommands = sqliteTable(
  'device_commands',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    status: text('status').notNull(),
    packet: text('packet_json', { mode: 'json' })
      .$type<import('./control-contract.js').StoredCommand>()
      .notNull(),
  },
  (table) => [
    index('device_commands_device').on(
      table.deviceId,
      sql`${table.expiresAt} DESC`,
    ),
  ],
);
