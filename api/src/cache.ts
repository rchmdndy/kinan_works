import { createClient, type RedisClientType } from 'redis';
import type { TelemetryPacket } from './types.js';

const key = (deviceId: string) => `kinan:telemetry:${deviceId}:last10`;
const channel = (deviceId: string) => `kinan:telemetry:${deviceId}`;

export type TelemetryCache = {
  connect(): Promise<void>;
  close(): Promise<void>;
  append(deviceId: string, packet: TelemetryPacket): Promise<void>;
  recent(deviceId: string): Promise<TelemetryPacket[]>;
  subscribe(
    deviceId: string,
    listener: (packet: TelemetryPacket) => void,
  ): Promise<() => Promise<void>>;
  ping(): Promise<void>;
};

const REDIS_CONNECT_TIMEOUT_MS = 2_000;

export class RedisTelemetryCache implements TelemetryCache {
  private readonly command: RedisClientType;
  private readonly subscriber: RedisClientType;

  constructor(url: string) {
    const socket = {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: false as const,
    };
    this.command = createClient({ url, socket });
    this.subscriber = this.command.duplicate();
    for (const client of [this.command, this.subscriber])
      client.on('error', (error) =>
        console.error(
          'redis error',
          error instanceof Error ? error.message : 'unknown error',
        ),
      );
  }

  async connect(): Promise<void> {
    try {
      await Promise.all([this.command.connect(), this.subscriber.connect()]);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    await Promise.allSettled(
      [this.command, this.subscriber].map(async (client) => {
        if (client.isOpen) await client.quit();
        else client.destroy();
      }),
    );
  }
  async ping(): Promise<void> {
    await this.command.ping();
  }

  async append(deviceId: string, packet: TelemetryPacket): Promise<void> {
    const json = JSON.stringify(packet);
    await this.command
      .multi()
      .rPush(key(deviceId), json)
      .lTrim(key(deviceId), -10, -1)
      .publish(channel(deviceId), json)
      .exec();
  }

  async recent(deviceId: string): Promise<TelemetryPacket[]> {
    return (await this.command.lRange(key(deviceId), 0, -1)).map(
      (value) => JSON.parse(value) as TelemetryPacket,
    );
  }

  async subscribe(
    deviceId: string,
    listener: (packet: TelemetryPacket) => void,
  ): Promise<() => Promise<void>> {
    const topic = channel(deviceId);
    await this.subscriber.subscribe(topic, (message) => {
      try {
        listener(JSON.parse(message) as TelemetryPacket);
      } catch {
        console.error('discarded invalid Redis telemetry event');
      }
    });
    return async () => {
      await this.subscriber
        .unsubscribe(topic, listener as never)
        .catch(() => undefined);
    };
  }
}

export class MemoryTelemetryCache implements TelemetryCache {
  private readonly packets = new Map<string, TelemetryPacket[]>();
  private readonly listeners = new Map<
    string,
    Set<(packet: TelemetryPacket) => void>
  >();
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async ping(): Promise<void> {}
  async append(deviceId: string, packet: TelemetryPacket): Promise<void> {
    this.packets.set(
      deviceId,
      [...(this.packets.get(deviceId) ?? []), packet].slice(-10),
    );
    for (const listener of this.listeners.get(deviceId) ?? []) listener(packet);
  }
  async recent(deviceId: string): Promise<TelemetryPacket[]> {
    return [...(this.packets.get(deviceId) ?? [])];
  }
  async subscribe(
    deviceId: string,
    listener: (packet: TelemetryPacket) => void,
  ): Promise<() => Promise<void>> {
    const set = this.listeners.get(deviceId) ?? new Set();
    set.add(listener);
    this.listeners.set(deviceId, set);
    return async () => {
      set.delete(listener);
    };
  }
}
