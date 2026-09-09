import { connect, type MqttClient } from 'mqtt';
export type Config = {
  mqttUrl: string;
  deviceId: string;
  deviceSecret: string;
  credentialVersion: number;
  parameterIds: string[];
  intervalMs: number;
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
  return {
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
      config.parameterIds.map((id, index) => [
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
export async function run(config = loadSimulatorConfig()): Promise<never> {
  const client: MqttClient = connect(config.mqttUrl, {
    username: config.deviceId,
    password: config.deviceSecret,
    clientId: config.deviceId,
    clean: true,
  });
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
  const topic = `devices/${config.deviceId}/${config.credentialVersion}/telemetry`;
  while (true) {
    const startedAt = Date.now();
    await client.publishAsync(
      topic,
      JSON.stringify(telemetryPacket(config, startedAt)),
      { qos: 1 },
    );
    await Bun.sleep(Math.max(0, config.intervalMs - (Date.now() - startedAt)));
  }
}
if (import.meta.main) await run();
