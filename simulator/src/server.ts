import type { MqttClient, IClientOptions } from 'mqtt';
import { connect } from 'mqtt';
import {
  DeviceTransport,
  sanitizeMqttError,
  type Scenario,
  type TransportEvent,
} from './index.js';
import {
  GrowthChamberDevice,
  growthChamberConfig,
  type GrowthChamberSensors,
} from './growth-chamber.js';
import { renderWebPage } from './web.js';

export const BROKER_URL = 'mqtts://mqtt.growsense.my.id:8883';
export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 4190;
const scenarios = new Set<Scenario>([
  'normal',
  'reject',
  'delayed',
  'no-response',
]);
const deviceIdPattern = /^[a-zA-Z0-9_-]{8,64}$/;

type ConnectBody = {
  deviceId?: unknown;
  deviceSecret?: unknown;
  credentialVersion?: unknown;
  intervalMs?: unknown;
  scenario?: unknown;
  ca?: unknown;
};

type SafeStatus = {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error: string | null;
  broker: typeof BROKER_URL;
  connectionId: string | null;
  revision: number;
  lastPublishAt: number | null;
  lastHeartbeatAt: number | null;
  state: unknown;
  telemetry: unknown;
};

type MqttFactory = (url: string, options: IClientOptions) => MqttClient;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export class SimulatorGateway {
  private transport: DeviceTransport | null = null;
  private device: GrowthChamberDevice | null = null;
  private credentials: {
    deviceId: string;
    secret: string;
    ca?: string;
  } | null = null;
  private status: SafeStatus['status'] = 'disconnected';
  private error: string | null = null;
  private lastHeartbeatAt: number | null = null;
  private latestTelemetry: unknown = null;
  private events: TransportEvent[] = [];
  private viewers = new Set<ReadableStreamDefaultController<string>>();
  private stopping: Promise<void> | null = null;

  constructor(private readonly mqttFactory: MqttFactory = connect) {}

  snapshot(): SafeStatus {
    return {
      status: this.status,
      error: this.error,
      broker: BROKER_URL,
      connectionId: this.device?.state.connectionId ?? null,
      revision: this.device?.state.revision ?? 0,
      lastPublishAt: this.transport?.lastPublishAt ?? null,
      lastHeartbeatAt: this.lastHeartbeatAt,
      state: this.device?.state ?? null,
      telemetry: this.latestTelemetry,
    };
  }

  private broadcast(kind: 'status' | 'event', data: unknown) {
    const message = `data: ${JSON.stringify({ kind, data })}\n\n`;
    for (const viewer of this.viewers) {
      try {
        viewer.enqueue(message);
      } catch {
        this.viewers.delete(viewer);
      }
    }
  }

  private record(event: TransportEvent) {
    const safe = { ...event, detail: sanitizeEventDetail(event.detail) };
    this.events.unshift(safe);
    this.events.length = Math.min(this.events.length, 100);
    if (
      event.type === 'publish' &&
      event.topic?.endsWith('/availability') &&
      (event.detail as { online?: unknown })?.online === true
    )
      this.lastHeartbeatAt = event.at;
    if (event.type === 'publish' && event.topic?.endsWith('/telemetry'))
      this.latestTelemetry = event.detail;
    if (event.type === 'error') {
      this.status = 'error';
      this.error = String(safe.detail);
    }
    this.broadcast('event', safe);
    this.broadcast('status', this.snapshot());
  }

  eventsStream() {
    return new ReadableStream<string>({
      start: (controller) => {
        this.viewers.add(controller);
        controller.enqueue(
          `data: ${JSON.stringify({ kind: 'status', data: this.snapshot() })}\n\n`,
        );
        for (const event of this.events.slice(0, 20))
          controller.enqueue(
            `data: ${JSON.stringify({ kind: 'event', data: event })}\n\n`,
          );
      },
      cancel: (controller) => {
        this.viewers.delete(controller);
      },
    });
  }

  async connect(body: ConnectBody) {
    if (this.transport || this.stopping)
      throw new Error('A device is already active');
    const input = validateConnect(body);
    this.credentials = {
      deviceId: input.deviceId,
      secret: input.deviceSecret,
      ca: input.ca,
    };
    this.status = 'connecting';
    this.error = null;
    const config = growthChamberConfig(input);
    this.device = new GrowthChamberDevice(config);
    this.transport = new DeviceTransport(
      this.device,
      (event) => this.record(event),
      this.mqttFactory,
    );
    this.broadcast('status', this.snapshot());
    try {
      await this.transport.start();
      this.status = 'connected';
      this.broadcast('status', this.snapshot());
    } catch (error) {
      this.error = sanitizeMqttError(error);
      this.status = 'error';
      this.transport = null;
      this.device = null;
      this.credentials = null;
      this.broadcast('status', this.snapshot());
      throw new Error(this.error);
    }
  }

  async disconnect(abrupt = false) {
    if (this.stopping) return this.stopping;
    const transport = this.transport;
    this.transport = null;
    this.stopping = (async () => {
      try {
        if (transport) await transport.stop(abrupt);
      } finally {
        this.device = null;
        this.credentials = null;
        this.status = 'disconnected';
        this.error = null;
        this.lastHeartbeatAt = null;
        this.latestTelemetry = null;
        this.stopping = null;
        this.broadcast('status', this.snapshot());
      }
    })();
    return this.stopping;
  }

  async reconnect() {
    if (!this.device || !this.credentials)
      throw new Error('No active device to reconnect');
    const old = this.device.config;
    const input = {
      deviceId: this.credentials.deviceId,
      deviceSecret: this.credentials.secret,
      credentialVersion: old.credentialVersion,
      intervalMs: old.intervalMs,
      scenario: old.scenario as Scenario,
      ca: this.credentials.ca,
    };
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.stop(true);
    this.device = new GrowthChamberDevice(growthChamberConfig(input));
    this.transport = new DeviceTransport(
      this.device,
      (event) => this.record(event),
      this.mqttFactory,
    );
    this.status = 'connecting';
    try {
      await this.transport.start();
      this.status = 'connected';
      this.error = null;
    } catch (error) {
      this.error = sanitizeMqttError(error);
      this.status = 'error';
      this.transport = null;
      this.device = null;
      this.credentials = null;
      throw new Error(this.error);
    } finally {
      this.broadcast('status', this.snapshot());
    }
  }

  async localControl(source: unknown, value: unknown) {
    if (!this.device || !this.transport)
      throw new Error('Device is not connected');
    if (source === 'systemRunning' && typeof value === 'boolean')
      this.device.setLocalControl(source, value);
    else if (
      (source === 'setpointTemp' || source === 'setpointRH') &&
      typeof value === 'number'
    )
      this.device.setLocalControl(source, value);
    else throw new Error('Invalid control input');
    await this.transport.publishState();
    this.broadcast('status', this.snapshot());
  }

  setSensor(source: unknown, value: unknown, error: unknown) {
    if (!this.device) throw new Error('Device is not connected');
    if (source !== 'tempSensor' && source !== 'rhSensor')
      throw new Error('Invalid sensor');
    const sensor: GrowthChamberSensors[typeof source] =
      error === true
        ? { status: 'error', error: 'simulated sensor error' }
        : { status: 'ok', value: Number(value) };
    this.device.setSensor(source, sensor);
  }

  hasCredentialsForTest() {
    return this.credentials !== null;
  }
}

function validateConnect(body: ConnectBody) {
  const deviceId =
    typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  const deviceSecret =
    typeof body.deviceSecret === 'string' ? body.deviceSecret : '';
  const credentialVersion = Number(body.credentialVersion);
  const intervalMs = Number(body.intervalMs);
  const scenario = typeof body.scenario === 'string' ? body.scenario : 'normal';
  const ca =
    typeof body.ca === 'string' && body.ca.trim() ? body.ca : undefined;
  if (!deviceIdPattern.test(deviceId)) throw new Error('Invalid device ID');
  if (!deviceSecret || deviceSecret.length > 1024)
    throw new Error('Invalid device secret');
  if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 1)
    throw new Error('Invalid credential version');
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 100 ||
    intervalMs > 30000
  )
    throw new Error('Publish interval must be 100–30000 ms');
  if (!scenarios.has(scenario as Scenario)) throw new Error('Invalid scenario');
  if (ca && (ca.length > 65536 || !ca.includes('BEGIN CERTIFICATE')))
    throw new Error('Invalid CA certificate');
  return {
    deviceId,
    deviceSecret,
    credentialVersion,
    intervalMs,
    scenario: scenario as Scenario,
    ca,
  };
}

function sanitizeEventDetail(detail: unknown): unknown {
  if (typeof detail === 'string') return detail.slice(0, 200);
  if (detail && typeof detail === 'object')
    return JSON.parse(JSON.stringify(detail)) as unknown;
  return detail;
}

function secureHeaders(response: Response, nonce: string) {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('pragma', 'no-cache');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'no-referrer');
  headers.set(
    'content-security-policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  );
  return new Response(response.body, { status: response.status, headers });
}

export function createSimulatorServer(
  options: {
    port?: number;
    mqttFactory?: MqttFactory;
  } = {},
) {
  const port = options.port ?? DEFAULT_PORT;
  const origin = `http://${HOST}:${port}`;
  const gateway = new SimulatorGateway(options.mqttFactory);
  const server = Bun.serve({
    hostname: HOST,
    port,
    async fetch(request) {
      const nonce = Buffer.from(
        crypto.getRandomValues(new Uint8Array(18)),
      ).toString('base64');
      const url = new URL(request.url);
      let response: Response;
      try {
        if (request.method === 'GET' && url.pathname === '/')
          response = new Response(renderWebPage(nonce), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        else if (request.method === 'GET' && url.pathname === '/health')
          response = json({ ok: true, broker: BROKER_URL });
        else if (request.method === 'GET' && url.pathname === '/api/status')
          response = json(gateway.snapshot());
        else if (request.method === 'GET' && url.pathname === '/api/events')
          response = new Response(gateway.eventsStream(), {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              connection: 'keep-alive',
            },
          });
        else if (
          request.method === 'POST' &&
          url.pathname.startsWith('/api/')
        ) {
          if (request.headers.get('origin') !== origin)
            response = json({ error: 'Invalid request origin' }, 403);
          else {
            const body = (await request.json()) as Record<string, unknown>;
            if (url.pathname === '/api/connect') await gateway.connect(body);
            else if (url.pathname === '/api/control')
              await gateway.localControl(body.source, body.value);
            else if (url.pathname === '/api/sensor')
              gateway.setSensor(body.source, body.value, body.error);
            else if (url.pathname === '/api/action') {
              if (body.action === 'clean') await gateway.disconnect(false);
              else if (body.action === 'abrupt') await gateway.disconnect(true);
              else if (body.action === 'reconnect') await gateway.reconnect();
              else throw new Error('Invalid action');
            } else response = json({ error: 'Not found' }, 404);
            response ??= json({ ok: true });
          }
        } else response = json({ error: 'Not found' }, 404);
      } catch (error) {
        const message =
          error instanceof SyntaxError
            ? 'Invalid JSON request'
            : error instanceof Error
              ? error.message.slice(0, 200)
              : 'Request failed';
        response = json({ error: message }, 400);
      }
      return secureHeaders(response, nonce);
    },
  });
  return { server, gateway, origin };
}

if (import.meta.main) {
  const port = Number(process.env.SIMULATOR_WEB_PORT || DEFAULT_PORT);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error('SIMULATOR_WEB_PORT must be 1024–65535');
  const { server, gateway } = createSimulatorServer({ port });
  const shutdown = async () => {
    await gateway.disconnect(false);
    await server.stop(true);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  console.log(
    `Growth Chamber simulator: http://${server.hostname}:${server.port}`,
  );
}
