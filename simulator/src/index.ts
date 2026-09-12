import { connect, type IClientOptions, type MqttClient } from 'mqtt';
import { readFileSync } from 'node:fs';
import { parameterSchema } from '../../api/src/validation.js';
import type { Parameter, SensorValue } from '../../api/src/types.js';
import {
  acceptsValue,
  commandSchema,
  type DeviceState,
  type CommandResult,
} from '../../api/src/control-contract.js';

export type Scenario = 'normal' | 'reject' | 'delayed' | 'no-response';
export type Config = {
  mqttUrl: string;
  deviceId: string;
  deviceSecret: string;
  credentialVersion: number;
  parameterIds: string[];
  parameters?: Parameter[];
  intervalMs: number;
  scenario?: Scenario | 'clean-offline' | 'abrupt-offline' | 'reconnect';
  caPath?: string;
  ca?: string;
};

const required = (env: NodeJS.ProcessEnv, name: string, fallback?: string) => {
  const value = env[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export function loadSimulatorConfig(
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const deviceId = required(env, 'SIMULATOR_DEVICE_ID');
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(deviceId))
    throw new Error('SIMULATOR_DEVICE_ID is invalid');
  const parameterIds = required(env, 'SIMULATOR_PARAMETER_IDS', 'parameter_1')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const scenario = env.SIMULATOR_SCENARIO || 'normal';
  if (
    ![
      'normal',
      'reject',
      'delayed',
      'no-response',
      'clean-offline',
      'abrupt-offline',
      'reconnect',
    ].includes(scenario)
  )
    throw new Error('Invalid SIMULATOR_SCENARIO');
  const version = Number(env.SIMULATOR_CREDENTIAL_VERSION || 1);
  const interval = Number(env.SIMULATOR_INTERVAL_MS || 10000);
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !Number.isSafeInteger(interval) ||
    interval < 100 ||
    interval > 30000
  )
    throw new Error('Invalid simulator version or interval (100..30000 ms)');
  const definitions = env.SIMULATOR_PARAMETERS_FILE
    ? JSON.parse(readFileSync(env.SIMULATOR_PARAMETERS_FILE, 'utf8'))
    : undefined;
  const parameters: Parameter[] | undefined =
    definitions === undefined
      ? undefined
      : Object.values(definitions.parameters ?? definitions).map((raw) => {
          const parameter = parameterSchema.parse(raw);
          if (!parameter.id)
            throw new Error('Dashboard parameter ID is required');
          return { ...parameter, id: parameter.id };
        });
  if (
    parameters &&
    new Set(parameters.map((parameter) => parameter.id)).size !==
      parameters.length
  )
    throw new Error('Duplicate parameter IDs');
  return {
    parameters,
    scenario: scenario as Config['scenario'],
    caPath: env.SIMULATOR_MQTT_CA_PATH,
    mqttUrl: required(env, 'SIMULATOR_MQTT_URL', 'mqtt://localhost:1883'),
    deviceId,
    deviceSecret: required(env, 'SIMULATOR_DEVICE_SECRET'),
    credentialVersion: version,
    parameterIds,
    intervalMs: interval,
  };
}

export function telemetryPacket(
  config: Config,
  timestamp = Date.now(),
  values?: Record<string, SensorValue>,
) {
  return {
    timestamp,
    writeId: crypto.randomUUID(),
    credentialVersion: config.credentialVersion,
    values:
      values ??
      Object.fromEntries(
        (config.parameters
          ? config.parameters
              .filter((parameter) => (parameter.type ?? 'nilai') === 'nilai')
              .map((parameter) => parameter.id)
          : config.parameterIds
        ).map((id, index) => [
          id,
          {
            status: 'ok' as const,
            value: Number(
              (20 + index * 10 + Math.sin(timestamp / 80_000) * 4).toFixed(2),
            ),
          },
        ]),
      ),
  };
}

export class SimulatedDevice {
  state: DeviceState;
  private results = new Map<string, CommandResult>();

  constructor(
    readonly config: Config,
    now = Date.now(),
    defaults: Record<string, boolean | number> = {},
  ) {
    this.state = {
      credentialVersion: config.credentialVersion,
      timestamp: now,
      connectionId: crypto.randomUUID(),
      revision: 0,
      parameters: (config.parameters ?? [])
        .filter(
          (parameter) =>
            parameter.type === 'control-state' ||
            parameter.type === 'control-setpoint',
        )
        .map((parameter) => ({
          id: parameter.id,
          value:
            defaults[parameter.id] ??
            (parameter.type === 'control-state' ? false : parameter.min!),
        })),
    };
  }

  applyLocal(parameterId: string, value: boolean | number, now = Date.now()) {
    const definition = this.config.parameters?.find(
      (parameter) => parameter.id === parameterId,
    );
    const actuator = this.state.parameters.find(
      (parameter) => parameter.id === parameterId,
    );
    if (!definition || !actuator || !acceptsValue(definition, value))
      throw new Error('Invalid local control value');
    if (actuator.value === value) return false;
    actuator.value = value;
    this.state.revision++;
    this.state.timestamp = now;
    return true;
  }

  execute(
    raw: unknown,
    now = Date.now(),
    retained = false,
  ): CommandResult | null {
    if (retained) return null;
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) return null;
    const command = parsed.data;
    const existing = this.results.get(command.commandId);
    if (existing) return existing;
    const actuator = this.state.parameters.find(
      (parameter) => parameter.id === command.parameterId,
    );
    const reason =
      command.expiresAt <= now
        ? 'expired'
        : command.timestamp > now + 5000 ||
            command.expiresAt - command.timestamp > 10000
          ? 'invalid timing'
          : command.credentialVersion !== this.state.credentialVersion ||
              command.connectionId !== this.state.connectionId
            ? 'stale connection or credentials'
            : command.revision !== this.state.revision
              ? 'stale revision'
              : !actuator ||
                  !this.config.parameters?.some(
                    (parameter) =>
                      parameter.id === command.parameterId &&
                      acceptsValue(parameter, command.value),
                  )
                ? 'invalid parameter value'
                : this.config.scenario === 'reject'
                  ? 'simulated interlock'
                  : undefined;
    const result: CommandResult = {
      credentialVersion: this.state.credentialVersion,
      connectionId: this.state.connectionId,
      timestamp: now,
      commandId: command.commandId,
      status: reason ? 'rejected' : 'succeeded',
      ...(reason ? { reason } : {}),
    };
    if (!reason && actuator) {
      actuator.value = command.value;
      this.state.revision++;
      this.state.timestamp = now;
    }
    this.results.set(command.commandId, result);
    if (this.results.size > 1000)
      this.results.delete(this.results.keys().next().value!);
    return result;
  }
}

export type TransportEvent = {
  at: number;
  type: 'status' | 'publish' | 'command' | 'result' | 'error';
  topic?: string;
  detail?: unknown;
};

type DeviceModel = SimulatedDevice & {
  telemetry?: (timestamp?: number) => ReturnType<typeof telemetryPacket>;
};

type MqttFactory = (url: string, options: IClientOptions) => MqttClient;

export class DeviceTransport {
  private client: MqttClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending = new Set<ReturnType<typeof setTimeout>>();
  private connecting: Promise<void> | null = null;
  lastPublishAt: number | null = null;

  constructor(
    readonly model: DeviceModel,
    private readonly onEvent: (event: TransportEvent) => void = () => {},
    private readonly mqttFactory: MqttFactory = connect,
  ) {}

  get connected() {
    return this.client?.connected === true;
  }

  private emit(event: Omit<TransportEvent, 'at'>) {
    this.onEvent({ at: Date.now(), ...event });
  }

  private availability(online: boolean) {
    return {
      credentialVersion: this.model.config.credentialVersion,
      connectionId: this.model.state.connectionId,
      timestamp: Date.now(),
      online,
    };
  }

  private async publish(kind: string, packet: unknown, retain: boolean) {
    if (!this.client?.connected) return;
    const topic = `devices/${this.model.config.deviceId}/${kind}`;
    await this.client.publishAsync(topic, JSON.stringify(packet), {
      qos: 1,
      retain,
    });
    this.lastPublishAt = Date.now();
    this.emit({ type: 'publish', topic, detail: packet });
  }

  async publishState() {
    this.model.state.timestamp = Date.now();
    await this.publish('state', this.model.state, true);
  }

  private async cycle() {
    this.model.state.timestamp = Date.now();
    await this.publish('state', this.model.state, true);
    await this.publish('availability', this.availability(true), true);
    const packet = this.model.telemetry
      ? this.model.telemetry()
      : telemetryPacket(this.model.config);
    await this.publish('telemetry', packet, false);
  }

  async start() {
    if (this.client || this.connecting)
      throw new Error('Device already active');
    const config = this.model.config;
    const prefix = `devices/${config.deviceId}`;
    const options: IClientOptions = {
      username: `${config.deviceId}-v${config.credentialVersion}`,
      password: config.deviceSecret,
      clientId: `${config.deviceId}-simulator-${crypto.randomUUID()}`,
      clean: true,
      reconnectPeriod: 0,
      keepalive: 5,
      rejectUnauthorized: true,
      ...(config.caPath ? { ca: readFileSync(config.caPath) } : {}),
      ...(config.ca ? { ca: config.ca } : {}),
      will: {
        topic: `${prefix}/availability`,
        payload: Buffer.from(JSON.stringify(this.availability(false))),
        qos: 1,
        retain: true,
      },
    };
    const client = this.mqttFactory(config.mqttUrl, options);
    this.client = client;
    client.on('error', (error) =>
      this.emit({ type: 'error', detail: sanitizeMqttError(error) }),
    );
    client.on('message', (topic, payload, packet) => {
      if (topic !== `${prefix}/commands` || payload.length > 32768) return;
      let raw: unknown;
      try {
        raw = JSON.parse(payload.toString());
      } catch {
        this.emit({ type: 'error', detail: 'Malformed command discarded' });
        return;
      }
      this.emit({ type: 'command', topic, detail: raw });
      const result = this.model.execute(raw, Date.now(), packet.retain);
      if (!result || config.scenario === 'no-response') return;
      void this.publishState();
      const sendResult = () => {
        this.emit({ type: 'result', detail: result });
        void this.publish('command-results', result, false);
      };
      if (config.scenario === 'delayed') {
        const timer = setTimeout(() => {
          this.pending.delete(timer);
          sendResult();
        }, 15000);
        this.pending.add(timer);
      } else sendResult();
    });
    this.connecting = new Promise<void>((resolve, reject) => {
      const connected = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        client.removeListener('connect', connected);
        client.removeListener('error', failed);
      };
      client.once('connect', connected);
      client.once('error', failed);
    });
    try {
      await this.connecting;
      await client.subscribeAsync(`${prefix}/commands`, { qos: 1 });
      await this.cycle();
      this.timer = setInterval(() => void this.cycle(), config.intervalMs);
      this.emit({ type: 'status', detail: 'connected' });
    } catch (error) {
      await this.closeClient(true);
      throw error;
    } finally {
      this.connecting = null;
    }
  }

  async stop(abrupt = false) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
    if (this.client?.connected && !abrupt)
      await this.publish('availability', this.availability(false), true);
    if (abrupt) this.client?.stream.destroy();
    await this.closeClient(abrupt);
    this.emit({
      type: 'status',
      detail: abrupt ? 'abruptly disconnected' : 'disconnected',
    });
  }

  private async closeClient(force: boolean) {
    const client = this.client;
    this.client = null;
    if (client) await client.endAsync(force).catch(() => undefined);
  }
}

export function sanitizeMqttError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : 'MQTT connection failed';
  if (/auth|credential|password|not authorized|bad user/i.test(message))
    return 'MQTT authentication or authorization failed';
  if (/certificate|tls|ssl|self[- ]signed|unable to verify/i.test(message))
    return 'MQTT TLS certificate verification failed';
  if (/timeout|timed out/i.test(message)) return 'MQTT connection timed out';
  return 'MQTT connection failed';
}

export async function run(config = loadSimulatorConfig()): Promise<void> {
  const model = new SimulatedDevice(config);
  const transport = new DeviceTransport(model, (event) => {
    if (event.type === 'error') console.error('Simulator MQTT:', event.detail);
    else if (event.type === 'status') console.log(JSON.stringify(event));
  });
  await transport.start();
  let stopped = false;
  const shutdown = () => {
    stopped = true;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  let cycles = 0;
  try {
    while (!stopped && transport.connected) {
      await Bun.sleep(config.intervalMs);
      cycles++;
      if (
        cycles === 3 &&
        ['clean-offline', 'abrupt-offline', 'reconnect'].includes(
          config.scenario || '',
        )
      ) {
        await transport.stop(config.scenario !== 'clean-offline');
        if (config.scenario === 'reconnect') {
          await Bun.sleep(8000);
          await run({ ...config, scenario: 'normal' });
        }
        return;
      }
    }
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    if (transport.connected) await transport.stop(false);
  }
}

if (import.meta.main) await run();
