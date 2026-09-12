import { createHash } from 'node:crypto';
import { parameterMap } from './repository.js';
import type { Device } from './types.js';

export const FIRMWARE_DEVICE_ID = 'growth-chamber-firmware-v1';
export const FIRMWARE_MARKER = 'firmware_growth_chamber_v1';
const definitions = [
  {
    id: 'tempSensor',
    label: 'tempSensor',
    unit: '°C',
    points: 1,
    type: 'nilai',
  },
  { id: 'rhSensor', label: 'rhSensor', unit: '%', points: 1, type: 'nilai' },
  {
    id: 'setpointTemp',
    label: 'setpointTemp',
    unit: '°C',
    points: 1,
    type: 'control-setpoint',
    min: 0,
    max: 50,
  },
  {
    id: 'setpointRH',
    label: 'setpointRH',
    unit: '%',
    points: 1,
    type: 'control-setpoint',
    min: 0,
    max: 100,
  },
  {
    id: 'systemRunning',
    label: 'systemRunning',
    unit: '',
    points: 0,
    type: 'control-state',
  },
] satisfies import('./types.js').Parameter[];

// Stable server-generated IDs for this dedicated profile only. Source names remain
// firmware variables, never a mutable key in the general parameter schema.
export const FIRMWARE_PARAMETERS = parameterMap(
  definitions.map((parameter) => ({
    ...parameter,
    id: `parameter_${createHash('sha256').update(`${FIRMWARE_MARKER}:${parameter.id}`).digest('hex').slice(0, 32)}`,
  })),
);

// A dedicated seed profile, not a mutable sourceKey on arbitrary parameters.
export function firmwareConfig(device: Device) {
  if (device.id !== FIRMWARE_DEVICE_ID) return null;
  if (Object.keys(device.parameters).length !== definitions.length)
    throw new Error('Firmware profile parameter count changed');
  const parameters = Object.values(FIRMWARE_PARAMETERS).map(
    (original, index) => {
      const current = device.parameters[original.id];
      if (
        !current ||
        current.id !== original.id ||
        current.type !== original.type
      )
        throw new Error('Firmware profile parameter missing or type changed');
      return { ...current, sourceKey: definitions[index]!.id };
    },
  );
  const body = {
    schemaVersion: 1,
    profile: 'growth-chamber-v1',
    deviceId: device.id,
    credentialVersion: device.credentialVersion,
    parameters,
  };
  return {
    ...body,
    revision: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
}
