import { FIRMWARE_PARAMETERS } from '../../api/src/firmware-profile.js';
import type { SensorValue } from '../../api/src/types.js';
import type { CommandResult } from '../../api/src/control-contract.js';
import {
  SimulatedDevice,
  telemetryPacket,
  type Config,
  type Scenario,
} from './index.js';

export const GROWTH_CHAMBER_PARAMETERS = Object.freeze(
  Object.values(FIRMWARE_PARAMETERS),
);

const bySource = Object.fromEntries(
  GROWTH_CHAMBER_PARAMETERS.map((parameter) => [parameter.label, parameter]),
);

export const GROWTH_CHAMBER_IDS = Object.freeze({
  tempSensor: bySource.tempSensor!.id,
  rhSensor: bySource.rhSensor!.id,
  setpointTemp: bySource.setpointTemp!.id,
  setpointRH: bySource.setpointRH!.id,
  systemRunning: bySource.systemRunning!.id,
});

export type GrowthChamberSensors = {
  tempSensor: SensorValue;
  rhSensor: SensorValue;
};

export class GrowthChamberDevice extends SimulatedDevice {
  sensors: GrowthChamberSensors = {
    tempSensor: { status: 'ok', value: 25 },
    rhSensor: { status: 'ok', value: 65 },
  };

  constructor(config: Config, now = Date.now()) {
    super({ ...config, parameters: [...GROWTH_CHAMBER_PARAMETERS] }, now, {
      [GROWTH_CHAMBER_IDS.setpointTemp]: 25,
      [GROWTH_CHAMBER_IDS.setpointRH]: 65,
      [GROWTH_CHAMBER_IDS.systemRunning]: false,
    });
  }

  setSensor(source: keyof GrowthChamberSensors, value: SensorValue): void {
    if (value.status === 'ok' && !Number.isFinite(value.value))
      throw new Error('Sensor value must be finite');
    if (value.status === 'error' && !value.error.trim())
      throw new Error('Sensor error is required');
    this.sensors[source] = value;
  }

  setLocalControl(source: 'setpointTemp' | 'setpointRH', value: number): void;
  setLocalControl(source: 'systemRunning', value: boolean): void;
  setLocalControl(
    source: 'setpointTemp' | 'setpointRH' | 'systemRunning',
    value: number | boolean,
    now = Date.now(),
  ): void {
    this.applyLocal(GROWTH_CHAMBER_IDS[source], value, now);
  }

  telemetry(timestamp = Date.now()) {
    return telemetryPacket(this.config, timestamp, {
      [GROWTH_CHAMBER_IDS.tempSensor]: this.sensors.tempSensor,
      [GROWTH_CHAMBER_IDS.rhSensor]: this.sensors.rhSensor,
    });
  }
}

export function growthChamberConfig(input: {
  deviceId: string;
  deviceSecret: string;
  credentialVersion: number;
  intervalMs: number;
  scenario?: Scenario;
  ca?: string;
}): Config {
  return {
    mqttUrl: 'mqtts://mqtt.growsense.my.id:8883',
    deviceId: input.deviceId,
    deviceSecret: input.deviceSecret,
    credentialVersion: input.credentialVersion,
    parameterIds: [],
    parameters: [...GROWTH_CHAMBER_PARAMETERS],
    intervalMs: input.intervalMs,
    scenario: input.scenario ?? 'normal',
    ca: input.ca,
  };
}

export type GrowthCommandResult = CommandResult;
