import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  availabilitySchema,
  commandSchema,
  resultSchema,
  stateSchema,
} from '../../../api/src/control-contract';
import { FIRMWARE_PARAMETERS } from '../../../api/src/firmware-profile';
import { firmwareSnippet, PLACEHOLDER_SECRET } from './firmware';
import type { Device } from './types';

const device: Device = {
  id: 'growth-chamber-firmware-v1',
  ownerUid: 'test',
  label: 'Growth Chamber',
  active: true,
  credentialVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  parameters: FIRMWARE_PARAMETERS,
};
const options = {
  mqttHost: 'localhost',
  mqttPort: 1883,
  mqttTlsPort: 8883,
  deviceSecret: PLACEHOLDER_SECRET,
};
const snippet = firmwareSnippet(device, options);
function payload(text: string, section: string) {
  const block = text.split(section)[1]!.split('\n//')[0]!;
  return JSON.parse(block.slice(block.indexOf('{'))) as Record<string, unknown>;
}

test('credential reference snapshot covers all five topics without a real secret', () => {
  expect(snippet).toMatchSnapshot();
  expect(snippet).not.toContain('"data"');
  expect(snippet).toContain(`mqtt_pass = "${PLACEHOLDER_SECRET}"`);
  for (const suffix of [
    'telemetry',
    'state',
    'availability',
    'commands',
    'command-results',
  ]) {
    expect(snippet).toContain(`devices/${device.id}/${suffix}`);
  }
});

test('examples match strict backend control envelopes and Growth Chamber mappings', () => {
  const telemetry = payload(snippet, '1. TELEMETRY');
  const state = stateSchema.parse(payload(snippet, '2. STATE'));
  availabilitySchema.parse(payload(snippet, '3. AVAILABILITY'));
  const command = commandSchema.parse(payload(snippet, '4. COMMANDS'));
  const result = resultSchema.parse(payload(snippet, '5. COMMAND-RESULTS'));
  const parameters = Object.values(device.parameters);
  expect(Object.keys(telemetry.values as object)).toEqual(
    parameters.filter((p) => p.type === 'nilai').map((p) => p.id),
  );
  expect(state.parameters).toEqual(
    parameters
      .filter((p) => p.type !== 'nilai')
      .map((p) => ({
        id: p.id,
        value: p.type === 'control-state' ? false : p.min,
      })),
  );
  expect(result.commandId).toBe(command.commandId);
  expect(command.expiresAt - command.timestamp).toBe(10000);
  expect(command.connectionId).toBe(state.connectionId);
  for (const source of [
    'tempSensor',
    'rhSensor',
    'setpointTemp',
    'setpointRH',
    'systemRunning',
  ]) {
    expect(snippet).toContain(source);
    expect(Object.keys(telemetry.values as object)).not.toContain(source);
  }
});

test('generic devices include every sensor/control and handle no controls or parameters', () => {
  const generic = {
    ...device,
    parameters: {
      sensor: {
        id: 'immutable_sensor',
        label: 'Renamed sensor',
        unit: 'C',
        points: 1,
      },
      switch: {
        id: 'immutable_switch',
        label: 'Renamed switch',
        unit: '',
        points: 0,
        type: 'control-state' as const,
      },
    },
  };
  const text = firmwareSnippet(generic, options);
  expect(Object.keys(payload(text, '1. TELEMETRY').values as object)).toEqual([
    'immutable_sensor',
  ]);
  expect(stateSchema.parse(payload(text, '2. STATE')).parameters).toEqual([
    { id: 'immutable_switch', value: false },
  ]);
  const empty = firmwareSnippet({ ...device, parameters: {} }, options);
  expect(payload(empty, '1. TELEMETRY').values).toEqual({});
  expect(stateSchema.parse(payload(empty, '2. STATE')).parameters).toEqual([]);
  expect(empty).toContain('jangan eksekusi target placeholder');
});

test('credential UI explains reference scope and hides secrets without refetching', () => {
  const source = readFileSync(
    new URL('../pages/DeviceCredential.svelte', import.meta.url),
    'utf8',
  );
  expect(source).toContain('Referensi lima topik MQTT');
  expect(source).toContain('bukan sketch siap kompilasi');
  expect(source).toContain('deviceSecret: secret || PLACEHOLDER_SECRET');
  expect(source).toMatch(
    /if \(secret\) \{\s*secret = '';\s*copyStatus = '';\s*return;/,
  );
});
