import { expect, test } from 'bun:test';
import type { StoredCommand } from '../src/control-contract.js';
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
  let notifications = 0;
  const unsubscribe = service.subscribe(id, () => {
    notifications++;
  });
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
  const availabilityNotifications = notifications;
  expect(availabilityNotifications).toBeGreaterThan(0);
  const input = {
    commandId: crypto.randomUUID(),
    parameterId: switchParameter.id,
    value: true,
  };
  const first = service.issue(id, input);
  expect(first.status).toBe('pending');
  expect(notifications).toBeGreaterThan(availabilityNotifications);
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
  unsubscribe();
  const unsubscribed = notifications;
  service.disconnect();
  expect(service.snapshot(id).online).toBe(false);
  ingest('availability', availability);
  expect(notifications).toBe(unsubscribed);
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
  // Parameters unknown to the dashboard are dropped, never exposed as
  // controls, and never block the rest of the state.
  ingest('state', {
    ...model.state,
    parameters: [...model.state.parameters, { id: 'invented', value: true }],
  });
  const accepted = service.snapshot('device_test');
  expect(accepted.online).toBe(true);
  expect(accepted.state?.parameters.map((p) => p.id)).not.toContain('invented');
  expect(accepted.state?.parameters.map((p) => p.id)).toContain(
    switchParameter.id,
  );
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

test('drifted device clocks and lost results never orphan commands', () => {
  const repo = new Repository(openDatabase(':memory:'));
  const id = 'device_skew';
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
  service.publisher = () => {};
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
  ingest('availability', availability);
  const issue = (value: boolean) =>
    service.issue(id, {
      commandId: crypto.randomUUID(),
      parameterId: switchParameter.id,
      value,
    });
  const wire = (command: StoredCommand) => ({
    commandId: command.commandId,
    parameterId: command.parameterId,
    value: command.value,
    credentialVersion: command.credentialVersion,
    timestamp: command.timestamp,
    expiresAt: command.expiresAt,
    connectionId: command.connectionId,
    revision: command.revision,
  });
  const first = wire(issue(false));

  // A device clock hundreds of milliseconds behind the server used to erase
  // the result and leave the command unknown.
  ingest('command-results', {
    ...model.execute(first)!,
    timestamp: Date.now() - 500,
  });
  expect(repo.getCommand(first.commandId)?.status).toBe('succeeded');

  // A lost result is recovered from the revision the device reports.
  ingest('state', model.state);
  const second = issue(true);
  expect(model.execute(wire(second))?.status).toBe('succeeded');
  repo.expireCommands(second.expiresAt);
  expect(repo.getCommand(second.commandId)?.status).toBe('unknown');
  ingest('state', { ...model.state, timestamp: Date.now() });
  expect(repo.getCommand(second.commandId)?.status).toBe('succeeded');
  expect(repo.getCommand(second.commandId)?.reason).toBeUndefined();

  // Devices stamp results with their own clock; a drifted stamp is harmless.
  const third = issue(false);
  ingest('command-results', {
    credentialVersion: 1,
    connectionId: third.connectionId,
    timestamp: Date.now() - 10 * 60_000,
    commandId: third.commandId,
    status: 'succeeded',
  });
  expect(repo.getCommand(third.commandId)?.status).toBe('succeeded');
  model.execute(wire(third));

  // A revision advance on another connection, or at the same revision,
  // proves nothing about this command.
  const fourth = issue(true);
  ingest('state', {
    ...model.state,
    connectionId: crypto.randomUUID(),
    revision: model.state.revision + 9,
    timestamp: Date.now(),
  });
  expect(repo.getCommand(fourth.commandId)?.status).toBe('pending');
  ingest('state', {
    ...model.state,
    revision: fourth.revision,
    timestamp: Date.now() + 1,
  });
  expect(repo.getCommand(fourth.commandId)?.status).toBe('pending');
  repo.close();
});

test('device clock never gates online state', () => {
  const repo = new Repository(openDatabase(':memory:'));
  const id = 'device_clockless';
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
  service.publisher = () => {};
  const ingest = (kind: string, packet: unknown, retained = false) =>
    service.consume(id, kind, Buffer.from(JSON.stringify(packet)), retained);
  const connection = crypto.randomUUID();
  const stateAt = (timestamp: number, revision = 0) => ({
    credentialVersion: 1,
    timestamp,
    connectionId: connection,
    revision,
    parameters: [{ id: switchParameter.id, value: false }],
  });
  const availabilityAt = (
    timestamp: number,
    online: boolean,
    connectionId = connection,
  ) => ({ credentialVersion: 1, timestamp, connectionId, online });

  // A device that connected before NTP stamps 1970-era time.
  ingest('availability', availabilityAt(68_561, true));
  ingest('state', stateAt(68_561));
  const online = service.snapshot(id);
  expect(online.online).toBe(true);
  expect(Date.now() - online.state!.timestamp).toBeLessThan(5000);

  // A clock far in the future does not poison later messages.
  ingest('state', stateAt(Date.now() + 86_400_000, 1));
  ingest('state', stateAt(68_562, 2));
  expect(service.snapshot(id).state?.revision).toBe(2);

  // Revisions still never move backwards within one connection.
  ingest('state', stateAt(Date.now(), 1));
  expect(service.snapshot(id).state?.revision).toBe(2);

  // A Will from a superseded connection cannot take the device offline.
  ingest('availability', availabilityAt(1, false, crypto.randomUUID()));
  expect(service.snapshot(id).online).toBe(true);
  ingest('availability', availabilityAt(1, false));
  expect(service.snapshot(id).online).toBe(false);

  // A retained replay never revives or overwrites live data.
  ingest('availability', availabilityAt(Date.now(), true), true);
  expect(service.snapshot(id).online).toBe(false);

  // Telemetry keeps a live connection fresh; heartbeats may be absent.
  ingest('availability', availabilityAt(1, true));
  const realNow = Date.now;
  try {
    const start = realNow();
    Date.now = () => start + 40_000;
    service.touch(id);
    Date.now = () => start + 80_000;
    expect(service.snapshot(id).online).toBe(true);
    Date.now = () => start + 130_000;
    expect(service.snapshot(id).online).toBe(false);
  } finally {
    Date.now = realNow;
  }
  service.touch('unknown_device');
  repo.close();
});
