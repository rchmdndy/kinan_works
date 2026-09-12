import { expect, test } from 'bun:test';
import { Repository, openDatabase } from '../src/repository.js';
import { ControlService } from '../src/control.js';
import type { Parameter } from '../src/types.js';
const switchParameter: Parameter = {
  id: 'parameter_switch',
  type: 'control-state',
  label: 'Switch',
  unit: '',
  points: 0,
};
import { SimulatedDevice } from '../../simulator/src/index.js';

test('control lifecycle: retained recovery, deduplication, ordering, timeout, late results and rotation', () => {
  const repo = new Repository(openDatabase(':memory:'));
  const id = 'device_control';
  repo.saveDeviceBundle(
    {
      id,
      ownerUid: 'owner',
      label: 'Test',
      active: true,
      credentialVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      parameters: { [switchParameter.id]: switchParameter },
    },
    { iv: 'test', ciphertext: 'test' },
  );
  const service = new ControlService(repo);
  const model = new SimulatedDevice({
    deviceId: id,
    deviceSecret: 'test',
    credentialVersion: 1,
    mqttUrl: 'mqtt://localhost',
    intervalMs: 1000,
    parameterIds: [],
    parameters: [switchParameter],
  });
  let publishes = 0;
  service.publisher = () => {
    publishes++;
  };
  const ingest = (kind: string, packet: unknown, retained = false) =>
    service.consume(id, kind, Buffer.from(JSON.stringify(packet)), retained);
  ingest('state', model.state, true);
  const availability = {
    credentialVersion: 1,
    connectionId: model.state.connectionId,
    timestamp: Date.now(),
    online: true,
  };
  ingest('availability', availability, true);
  expect(service.snapshot(id).online).toBe(false);
  ingest('availability', availability);
  expect(service.snapshot(id).online).toBe(true);
  const input = {
    commandId: crypto.randomUUID(),
    parameterId: switchParameter.id,
    value: true,
  };
  const first = service.issue(id, input);
  expect(first.status).toBe('pending');
  service.issue(id, input);
  expect(publishes).toBe(1);
  expect(() =>
    service.issue(id, { ...input, commandId: crypto.randomUUID() }),
  ).toThrow('unresolved');
  const { deviceId, status, ...packet } = first;
  expect(deviceId).toBe(id);
  expect(status).toBe('pending');
  const result = model.execute(packet)!;
  expect(result.status).toBe('succeeded');
  expect(model.execute(packet)).toEqual(result);
  expect(model.state.revision).toBe(1);
  repo.expireCommands(first.expiresAt);
  expect(repo.getCommand(first.commandId)?.status).toBe('unknown');
  ingest('command-results', result, true);
  expect(repo.getCommand(first.commandId)?.status).toBe('unknown');
  ingest('command-results', result);
  expect(repo.getCommand(first.commandId)?.status).toBe('succeeded');
  expect(service.snapshot(id).state?.parameters[0]?.value).toBe(false);
  ingest('state', model.state);
  expect(service.snapshot(id).state?.parameters[0]?.value).toBe(true);
  expect(
    model.execute({
      ...packet,
      commandId: crypto.randomUUID(),
      expiresAt: Date.now() - 1,
    })?.reason,
  ).toBe('expired');
  expect(
    model.execute({ ...packet, commandId: crypto.randomUUID() })?.reason,
  ).toBe('stale revision');
  expect(
    model.execute({
      ...packet,
      commandId: crypto.randomUUID(),
      revision: 1,
      value: 42,
    })?.reason,
  ).toBe('invalid parameter value');
  expect(model.execute(packet, Date.now(), true)).toBeNull();
  service.disconnect();
  expect(service.snapshot(id).online).toBe(false);
  ingest('availability', availability);
  repo.updateDevice(id, { credentialVersion: 2 });
  expect(service.snapshot(id).online).toBe(false);
  expect(() =>
    service.issue(id, { ...input, commandId: crypto.randomUUID() }),
  ).toThrow('offline');
  repo.close();
});

test('dashboard definitions reject invented controls and sensor commands', () => {
  const repo = new Repository(openDatabase(':memory:'));
  const sensor: Parameter = {
    id: 'sensor',
    type: 'nilai',
    label: 'Sensor',
    unit: 'C',
    points: 1,
  };
  const target: Parameter = {
    id: 'target',
    type: 'control-setpoint',
    label: 'Target',
    unit: 'C',
    points: 1,
    min: 10,
    max: 30,
  };
  const parameters = [switchParameter, sensor, target];
  repo.saveDeviceBundle(
    {
      id: 'device_test',
      ownerUid: 'owner',
      label: 'Test',
      active: true,
      credentialVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      parameters: Object.fromEntries(parameters.map((p) => [p.id, p])),
    },
    { iv: 'x', ciphertext: 'x' },
  );
  const model = new SimulatedDevice({
    deviceId: 'device_test',
    deviceSecret: 'x',
    credentialVersion: 1,
    mqttUrl: 'mqtt://localhost',
    intervalMs: 1000,
    parameterIds: [],
    parameters,
  });
  const service = new ControlService(repo);
  service.publisher = () => {};
  const ingest = (kind: string, packet: unknown) =>
    service.consume(
      'device_test',
      kind,
      Buffer.from(JSON.stringify(packet)),
      false,
    );
  ingest('state', model.state);
  ingest('availability', {
    credentialVersion: 1,
    connectionId: model.state.connectionId,
    timestamp: Date.now(),
    online: true,
  });
  for (const [parameterId, value] of [
    ['sensor', 20],
    ['unknown', true],
    ['target', 31],
    ['target', true],
    [switchParameter.id, 1],
  ] as const)
    expect(() =>
      service.issue('device_test', {
        commandId: crypto.randomUUID(),
        parameterId,
        value,
      }),
    ).toThrow('dashboard parameter');
  ingest('state', {
    ...model.state,
    revision: 99,
    parameters: [{ id: 'invented', value: true }],
  });
  expect(service.snapshot('device_test').state?.revision).toBe(0);
  const command = service.issue('device_test', {
    commandId: crypto.randomUUID(),
    parameterId: 'target',
    value: 30,
  });
  const packet = {
    commandId: command.commandId,
    parameterId: command.parameterId,
    value: command.value,
    credentialVersion: command.credentialVersion,
    timestamp: command.timestamp,
    expiresAt: command.expiresAt,
    connectionId: command.connectionId,
    revision: command.revision,
  };
  expect(model.execute(packet)?.status).toBe('succeeded');
  expect(model.state.parameters.find((p) => p.id === 'target')?.value).toBe(30);
  expect(() =>
    service.issue('device_test', {
      commandId: command.commandId,
      parameterId: 'target',
      value: 29,
    }),
  ).toThrow('already used');
  repo.close();
});
