import { expect, test } from 'bun:test';
import {
  GROWTH_CHAMBER_IDS,
  GROWTH_CHAMBER_PARAMETERS,
  GrowthChamberDevice,
  growthChamberConfig,
} from './growth-chamber.js';

const config = () =>
  growthChamberConfig({
    deviceId: 'device_test',
    deviceSecret: 'secret',
    credentialVersion: 2,
    intervalMs: 1000,
  });

test('uses exactly five unique firmware parameters and firmware defaults', () => {
  expect(GROWTH_CHAMBER_PARAMETERS).toHaveLength(5);
  expect(new Set(GROWTH_CHAMBER_PARAMETERS.map(({ id }) => id)).size).toBe(5);
  const device = new GrowthChamberDevice(config(), 100);
  expect(device.state.parameters).toEqual([
    { id: GROWTH_CHAMBER_IDS.setpointTemp, value: 25 },
    { id: GROWTH_CHAMBER_IDS.setpointRH, value: 65 },
    { id: GROWTH_CHAMBER_IDS.systemRunning, value: false },
  ]);
});

test('telemetry contains only sensors and supports sensor errors', () => {
  const device = new GrowthChamberDevice(config(), 100);
  device.setSensor('tempSensor', { status: 'ok', value: 27.5 });
  device.setSensor('rhSensor', {
    status: 'error',
    error: 'sensor unavailable',
  });
  expect(device.telemetry(200)).toMatchObject({
    timestamp: 200,
    credentialVersion: 2,
    values: {
      [GROWTH_CHAMBER_IDS.tempSensor]: { status: 'ok', value: 27.5 },
      [GROWTH_CHAMBER_IDS.rhSensor]: {
        status: 'error',
        error: 'sensor unavailable',
      },
    },
  });
  expect(Object.keys(device.telemetry().values)).toHaveLength(2);
});

test('local controls enforce bounds and increment revision only on change', () => {
  const device = new GrowthChamberDevice(config(), 100);
  device.setLocalControl('setpointTemp', 50);
  device.setLocalControl('setpointRH', 0);
  device.setLocalControl('systemRunning', true);
  expect(device.state.revision).toBe(3);
  device.setLocalControl('systemRunning', true);
  expect(device.state.revision).toBe(3);
  expect(() => device.setLocalControl('setpointTemp', 51)).toThrow(
    'Invalid local control value',
  );
});

test('commands apply, reject stale revisions, and deduplicate results', () => {
  const device = new GrowthChamberDevice(config(), 100);
  const command = {
    commandId: crypto.randomUUID(),
    parameterId: GROWTH_CHAMBER_IDS.setpointTemp,
    value: 30,
    credentialVersion: 2,
    timestamp: 101,
    expiresAt: 10000,
    connectionId: device.state.connectionId,
    revision: 0,
  };
  const result = device.execute(command, 102);
  expect(result?.status).toBe('succeeded');
  expect(device.state.revision).toBe(1);
  expect(device.execute(command, 103)).toEqual(result);
  expect(device.state.revision).toBe(1);
  expect(
    device.execute({ ...command, commandId: crypto.randomUUID() }, 104)?.reason,
  ).toBe('stale revision');
  expect(device.execute(command, 105, true)).toBeNull();
});
