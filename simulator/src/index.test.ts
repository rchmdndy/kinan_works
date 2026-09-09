import { expect, test } from 'bun:test';
import { loadSimulatorConfig, telemetryPacket } from './index.js';
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
