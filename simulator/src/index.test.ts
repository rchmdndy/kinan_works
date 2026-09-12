import { expect, test } from 'bun:test';
import {
  loadSimulatorConfig,
  telemetryPacket,
  SimulatedDevice,
} from './index.js';
test('builds authenticated MQTT telemetry packets', () => {
  const config = loadSimulatorConfig({
    SIMULATOR_DEVICE_ID: 'device_1234',
    SIMULATOR_DEVICE_SECRET: 'secret',
    SIMULATOR_PARAMETER_IDS: 'temperature,humidity',
  });
  const packet = telemetryPacket(config, 100);
  expect(packet).toMatchObject({ timestamp: 100, credentialVersion: 1 });
  expect(Object.keys(packet.values)).toEqual(['temperature', 'humidity']);
});

test('simulator applies only dashboard control definitions, rejects interlocks, stale and expired commands', () => {
  const config = {
    mqttUrl: 'mqtt://localhost',
    deviceId: 'device_test',
    deviceSecret: 'x',
    credentialVersion: 1,
    parameterIds: ['legacy'],
    intervalMs: 1000,
    parameters: [
      {
        id: 'sensor_a',
        label: 'Sensor',
        type: 'nilai' as const,
        unit: 'C',
        points: 1,
      },
      {
        id: 'switch_a',
        label: 'Switch',
        type: 'control-state' as const,
        unit: '',
        points: 0,
      },
      {
        id: 'target_a',
        label: 'Target',
        type: 'control-setpoint' as const,
        unit: 'C',
        points: 1,
        min: 5,
        max: 15,
      },
    ],
  };
  expect(Object.keys(telemetryPacket(config, 100).values)).toEqual([
    'sensor_a',
  ]);
  const model = new SimulatedDevice(config, 100);
  const command = {
    commandId: crypto.randomUUID(),
    parameterId: 'switch_a',
    value: true,
    credentialVersion: 1,
    timestamp: 100,
    expiresAt: 10100,
    connectionId: model.state.connectionId,
    revision: 0,
  };
  expect(model.execute(command, 10100)?.reason).toBe('expired');
  expect(model.state.revision).toBe(0);
  const next = { ...command, commandId: crypto.randomUUID() };
  expect(model.execute(next, 101)?.status).toBe('succeeded');
  expect(model.execute(next, 102)?.status).toBe('succeeded');
  expect(model.state.revision).toBe(1);
  expect(
    model.execute(
      {
        ...command,
        commandId: crypto.randomUUID(),
        connectionId: crypto.randomUUID(),
      },
      103,
    )?.reason,
  ).toBe('stale connection or credentials');
  const reject = new SimulatedDevice({ ...config, scenario: 'reject' }, 100);
  expect(
    reject.execute({ ...next, connectionId: reject.state.connectionId }, 101)
      ?.reason,
  ).toBe('simulated interlock');
  expect(reject.state.revision).toBe(0);
  expect(
    new SimulatedDevice({ ...config, parameters: undefined }).state.parameters,
  ).toEqual([]);
});
