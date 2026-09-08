import { readFileSync } from 'node:fs';
import { connect, type IClientOptions, type MqttClient } from 'mqtt';
import type { Config } from './config.js';
import type { TelemetryCache } from './cache.js';
import type { Repository } from './repository.js';
import { telemetrySchema } from './validation.js';
import { validateTelemetryParameters } from './repository.js';

export type TelemetryConsumer = { connect(): Promise<void>; close(): Promise<void>; connected(): boolean };

export class MqttTelemetryConsumer implements TelemetryConsumer {
  private client: MqttClient | null = null;
  constructor(private readonly repository: Repository, private readonly cache: TelemetryCache, private readonly config: Config) {}

  async connect(): Promise<void> {
    const options: IClientOptions = {
      username: this.config.MQTT_INGEST_USERNAME,
      password: this.config.MQTT_INGEST_PASSWORD,
      clientId: `kinan-api-${crypto.randomUUID()}`,
      clean: true,
      reconnectPeriod: 1000,
      connectTimeout: 10_000,
      rejectUnauthorized: this.config.MQTT_REJECT_UNAUTHORIZED === 'true'
    };
    if (this.config.MQTT_CA_PATH) options.ca = readFileSync(this.config.MQTT_CA_PATH);
    const client = connect(this.config.MQTT_URL, options);
    this.client = client;
    client.on('error', (error) => console.error('mqtt error', error.message));
    client.on('message', (topic, payload) => { void this.consume(topic, payload); });
    client.on('connect', () => { void client.subscribeAsync('devices/+/+/telemetry', { qos: 1 }).catch((error) => console.error('mqtt subscribe failed', error.message)); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MQTT connection timed out')), 10_000);
      client.once('connect', () => { clearTimeout(timeout); resolve(); });
      client.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });
  }

  connected(): boolean { return this.client?.connected === true; }
  async close(): Promise<void> { if (this.client) await this.client.endAsync(true); }

  async consume(topic: string, payload: Buffer): Promise<void> {
    try {
      if (payload.byteLength > this.config.TELEMETRY_MAX_BYTES) throw new Error('payload too large');
      const topicMatch = /^devices\/([a-zA-Z0-9_-]{8,64})\/([1-9][0-9]*)\/telemetry$/.exec(topic);
      if (!topicMatch) throw new Error('invalid topic');
      const deviceId = topicMatch[1]!;
      const topicVersion = Number(topicMatch[2]);
      const parsed = telemetrySchema.safeParse(JSON.parse(payload.toString('utf8')));
      if (!parsed.success) throw new Error('invalid payload');
      const packet = parsed.data;
      const device = this.repository.getDevice(deviceId);
      if (!device || !device.active || device.credentialVersion !== topicVersion || packet.credentialVersion !== topicVersion) throw new Error('inactive or stale credentials');
      if (Math.abs(Date.now() - packet.timestamp) > this.config.TELEMETRY_MAX_CLOCK_SKEW_MS) throw new Error('timestamp outside allowed clock skew');
      if (!validateTelemetryParameters(packet.values, device.parameters)) throw new Error('parameters do not match device');
      const result = this.repository.saveTelemetry(deviceId, packet);
      if (result.inserted) await this.cache.append(deviceId, packet);
    } catch (error) {
      console.error('discarded telemetry', { topic, reason: error instanceof Error ? error.message : 'unknown' });
    }
  }
}
