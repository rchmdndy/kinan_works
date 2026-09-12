import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IClientOptions, MqttClient } from 'mqtt';
import {
  BROKER_URL,
  createSimulatorServer,
  SimulatorGateway,
} from './server.js';
import { renderWebPage } from './web.js';

test('web form submits the credential field expected by the gateway', () => {
  const html = renderWebPage('test-nonce');
  expect(html).toContain('name="deviceSecret"');
  expect(html).not.toContain('name="secret"');
});

type Published = { topic: string; payload: string; options: unknown };

class FakeMqtt extends EventEmitter {
  connected = false;
  stream = { destroy: () => void this.closeAbruptly() };
  published: Published[] = [];
  subscriptions: string[] = [];
  ended = false;

  constructor() {
    super();
    queueMicrotask(() => {
      this.connected = true;
      this.emit('connect');
    });
  }

  async publishAsync(topic: string, payload: string, options: unknown) {
    this.published.push({ topic, payload, options });
  }

  async subscribeAsync(topic: string) {
    this.subscriptions.push(topic);
  }

  async endAsync() {
    this.connected = false;
    this.ended = true;
  }

  closeAbruptly() {
    this.connected = false;
  }
}

const servers: ReturnType<typeof createSimulatorServer>[] = [];
afterEach(async () => {
  for (const instance of servers.splice(0)) {
    await instance.gateway.disconnect();
    await instance.server.stop(true);
  }
});

describe('gateway security', () => {
  test('locks broker and TLS verification and never returns credentials', async () => {
    let connection:
      | { url: string; options: IClientOptions; client: FakeMqtt }
      | undefined;
    const instance = createSimulatorServer({
      port: 43191,
      mqttFactory: (url, options) => {
        const client = new FakeMqtt();
        connection = { url, options, client };
        return client as unknown as MqttClient;
      },
    });
    servers.push(instance);
    const secret = 'DO_NOT_LEAK_secret_123';
    const ca =
      '-----BEGIN CERTIFICATE-----\nDO_NOT_LEAK_CA\n-----END CERTIFICATE-----';
    const response = await fetch(`${instance.origin}/api/connect`, {
      method: 'POST',
      headers: {
        origin: instance.origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        deviceId: 'device_1234',
        deviceSecret: secret,
        credentialVersion: 1,
        intervalMs: 30000,
        scenario: 'normal',
        ca,
      }),
    });
    expect(response.status).toBe(200);
    expect(connection?.url).toBe(BROKER_URL);
    expect(connection?.options.rejectUnauthorized).toBe(true);
    expect(connection?.options.password).toBe(secret);
    expect(connection?.options.ca).toBe(ca);
    const statusResponse = await fetch(`${instance.origin}/api/status`);
    const text = await statusResponse.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain('DO_NOT_LEAK_CA');
    expect(statusResponse.headers.get('cache-control')).toBe('no-store');
    expect(statusResponse.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    expect(connection?.client.subscriptions).toEqual([
      'devices/device_1234/commands',
    ]);
    expect(connection?.client.published).toHaveLength(3);
    for (const packet of connection?.client.published ?? [])
      expect(packet.options).toMatchObject({ qos: 1 });
  });

  test('rejects non-exact origins before MQTT creation', async () => {
    let calls = 0;
    const instance = createSimulatorServer({
      port: 43192,
      mqttFactory: () => {
        calls++;
        return new FakeMqtt() as unknown as MqttClient;
      },
    });
    servers.push(instance);
    const response = await fetch(`${instance.origin}/api/connect`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost:43192',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(calls).toBe(0);
  });

  test('keeps one active device for multiple viewers and cleans credentials', async () => {
    let calls = 0;
    const clients: FakeMqtt[] = [];
    const gateway = new SimulatorGateway(() => {
      calls++;
      const client = new FakeMqtt();
      clients.push(client);
      return client as unknown as MqttClient;
    });
    await gateway.connect({
      deviceId: 'device_1234',
      deviceSecret: 'hidden-secret',
      credentialVersion: 1,
      intervalMs: 30000,
      scenario: 'normal',
    });
    const readerA = gateway.eventsStream().getReader();
    const readerB = gateway.eventsStream().getReader();
    expect(calls).toBe(1);
    await expect(
      gateway.connect({
        deviceId: 'device_5678',
        deviceSecret: 'another',
        credentialVersion: 1,
        intervalMs: 30000,
      }),
    ).rejects.toThrow('already active');
    expect(calls).toBe(1);
    expect(gateway.hasCredentialsForTest()).toBe(true);
    await readerA.cancel();
    await readerB.cancel();
    await gateway.disconnect(false);
    expect(gateway.hasCredentialsForTest()).toBe(false);
    expect(clients[0]?.published.at(-1)?.topic).toEndWith('/availability');
    expect(clients[0]?.published.at(-1)?.payload).toContain('"online":false');
  });

  test('abrupt disconnect does not publish clean offline packet', async () => {
    const client = new FakeMqtt();
    const gateway = new SimulatorGateway(() => client as unknown as MqttClient);
    await gateway.connect({
      deviceId: 'device_1234',
      deviceSecret: 'hidden-secret',
      credentialVersion: 1,
      intervalMs: 30000,
      scenario: 'normal',
    });
    const before = client.published.length;
    await gateway.disconnect(true);
    expect(client.published.length).toBe(before);
    expect(gateway.hasCredentialsForTest()).toBe(false);
  });
});
