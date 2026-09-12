import { connect, type MqttClient } from 'mqtt';
import { readFileSync } from 'node:fs';
import { parameterSchema } from '../../api/src/validation.js';
import type { Parameter } from '../../api/src/types.js';
import {
  acceptsValue,
  commandSchema,
  type DeviceState,
  type CommandResult,
} from '../../api/src/control-contract.js';
export type Config = {
  mqttUrl: string;
  deviceId: string;
  deviceSecret: string;
  credentialVersion: number;
  parameterIds: string[];
  parameters?: Parameter[];
  intervalMs: number;
  scenario?:
    | 'normal'
    | 'reject'
    | 'delayed'
    | 'no-response'
    | 'clean-offline'
    | 'abrupt-offline'
    | 'reconnect';
  caPath?: string;
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
          const p = parameterSchema.parse(raw);
          if (!p.id) throw new Error('Dashboard parameter ID is required');
          return { ...p, id: p.id };
        });
  if (
    parameters &&
    new Set(parameters.map((p) => p.id)).size !== parameters.length
  )
    throw new Error('Duplicate parameter IDs');
  return {
    parameters,
    scenario: scenario as Config['scenario'],
    caPath: env.SIMULATOR_MQTT_CA_PATH,
    mqttUrl: required(env, 'SIMULATOR_MQTT_URL', 'mqtt://localhost:1883'),
    deviceId,
    deviceSecret: required(env, 'SIMULATOR_DEVICE_SECRET'),
    credentialVersion: Number(
      required(env, 'SIMULATOR_CREDENTIAL_VERSION', '1'),
    ),
    parameterIds,
    intervalMs: Number(required(env, 'SIMULATOR_INTERVAL_MS', '10000')),
  };
}
export function telemetryPacket(config: Config, timestamp = Date.now()) {
  return {
    timestamp,
    writeId: crypto.randomUUID(),
    credentialVersion: config.credentialVersion,
    values: Object.fromEntries(
      (config.parameters
        ? config.parameters
            .filter((p) => (p.type ?? 'nilai') === 'nilai')
            .map((p) => p.id)
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
  ) {
    this.state = {
      credentialVersion: config.credentialVersion,
      timestamp: now,
      connectionId: crypto.randomUUID(),
      revision: 0,
      parameters: (config.parameters ?? [])
        .filter(
          (p) => p.type === 'control-state' || p.type === 'control-setpoint',
        )
        .map((p) => ({
          id: p.id,
          value: p.type === 'control-state' ? false : p.min!,
        })),
    };
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
      (a) => a.id === command.parameterId,
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
                    (p) =>
                      p.id === command.parameterId &&
                      acceptsValue(p, command.value),
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
      Object.assign(actuator, { value: command.value });
      this.state.revision++;
      this.state.timestamp = now;
    }
    this.results.set(command.commandId, result);
    // Commands expire within ten seconds; cap memory without permitting old execution.
    if (this.results.size > 1000)
      this.results.delete(this.results.keys().next().value!);
    return result;
  }
}
export async function run(config = loadSimulatorConfig()): Promise<void> {
  const model = new SimulatedDevice(config);
  const prefix = `devices/${config.deviceId}`;
  let stopped = false;
  let cycles = 0;
  const availability = (online: boolean) => ({
    credentialVersion: config.credentialVersion,
    connectionId: model.state.connectionId,
    timestamp: Date.now(),
    online,
  });
  const publish = async (kind: string, packet: unknown, retain: boolean) => {
    if (client.connected)
      await client.publishAsync(`${prefix}/${kind}`, JSON.stringify(packet), {
        qos: 1,
        retain,
      });
  };
  const client: MqttClient = connect(config.mqttUrl, {
    username: `${config.deviceId}-v${config.credentialVersion}`,
    password: config.deviceSecret,
    clientId: `${config.deviceId}-simulator`,
    clean: true,
    reconnectPeriod: 0,
    keepalive: 5,
    rejectUnauthorized: true,
    ...(config.caPath ? { ca: readFileSync(config.caPath) } : {}),
    will: {
      topic: `${prefix}/availability`,
      payload: Buffer.from(JSON.stringify(availability(false))),
      qos: 1,
      retain: true,
    },
  });
  client.on('error', (error) =>
    console.error('Simulator MQTT:', error.message),
  );
  const pending = new Set<ReturnType<typeof setTimeout>>();
  client.on('message', (topic, payload, packet) => {
    if (topic !== `${prefix}/commands` || payload.length > 32768) return;
    try {
      const result = model.execute(
        JSON.parse(payload.toString()),
        Date.now(),
        packet.retain,
      );
      if (!result || config.scenario === 'no-response') return;
      void publish('state', model.state, true);
      if (config.scenario === 'delayed') {
        const timer = setTimeout(() => {
          pending.delete(timer);
          void publish('command-results', result, false);
        }, 15000);
        pending.add(timer);
      } else void publish('command-results', result, false);
    } catch {
      console.error('Simulator rejected malformed command');
    }
  });
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
  await client.subscribeAsync(`${prefix}/commands`, { qos: 1 });
  const shutdown = () => {
    stopped = true;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    while (!stopped && client.connected) {
      model.state.timestamp = Date.now();
      await publish('state', model.state, true);
      await publish('availability', availability(true), true);
      await publish('telemetry', telemetryPacket(config), false);
      console.log(
        JSON.stringify({
          scenario: config.scenario || 'normal',
          cycle: ++cycles,
          revision: model.state.revision,
          online: true,
        }),
      );
      if (
        cycles === 3 &&
        ['clean-offline', 'abrupt-offline', 'reconnect'].includes(
          config.scenario || '',
        )
      ) {
        if (config.scenario === 'clean-offline')
          await publish('availability', availability(false), true);
        else client.stream.destroy();
        break;
      }
      await Bun.sleep(config.intervalMs);
    }
    if (stopped && client.connected)
      await publish('availability', availability(false), true);
  } finally {
    for (const timer of pending) clearTimeout(timer);
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await client.endAsync(true);
  }
  if (config.scenario === 'reconnect' && !stopped) {
    await Bun.sleep(8000);
    await run({ ...config, scenario: 'normal' });
  }
}
if (import.meta.main) await run();
