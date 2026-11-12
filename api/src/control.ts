import type { Repository } from './repository.js';
import {
  acceptsValue,
  availabilitySchema,
  commandInputSchema,
  resultSchema,
  stateSchema,
  COMMAND_TTL_MS,
  CONTROL_FRESH_MS,
  RESULT_CLOCK_SKEW_MS,
  type Command,
  type DeviceState,
  type StoredCommand,
} from './control-contract.js';

export class ControlService {
  private live = new Map<string, { connectionId: string; seenAt: number }>();
  private listeners = new Map<string, Set<() => void>>();
  publisher: ((deviceId: string, command: Command) => void) | null = null;
  constructor(private readonly repository: Repository) {}
  disconnect() {
    this.live.clear();
  }
  subscribe(deviceId: string, listener: () => void): () => void {
    let listeners = this.listeners.get(deviceId);
    if (!listeners) this.listeners.set(deviceId, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(deviceId);
    };
  }
  private notify(deviceId: string): void {
    for (const listener of this.listeners.get(deviceId) ?? []) listener();
  }
  snapshot(deviceId: string) {
    this.repository.expireCommands();
    const device = this.repository.getDevice(deviceId);
    const stored = this.repository.getControl(deviceId);
    const live = this.live.get(deviceId);
    const online = !!(
      device?.active &&
      stored.availability?.online &&
      live &&
      Date.now() - live.seenAt < CONTROL_FRESH_MS &&
      stored.availability.credentialVersion === device.credentialVersion &&
      stored.state?.credentialVersion === device.credentialVersion &&
      stored.state.connectionId === live.connectionId &&
      Date.now() - stored.state.timestamp < CONTROL_FRESH_MS &&
      this.publisher
    );
    return {
      ...stored,
      state: stored.state
        ? {
            ...stored.state,
            parameters: stored.state.parameters.filter(
              (value) =>
                device?.parameters[value.id] &&
                acceptsValue(device.parameters[value.id]!, value.value),
            ),
          }
        : null,
      online,
      commands: this.repository.listCommands(deviceId),
    };
  }
  consume(
    deviceId: string,
    kind: string,
    payload: Buffer,
    retained: boolean,
  ): void {
    if (payload.length > 32_768) return;
    const device = this.repository.getDevice(deviceId);
    if (!device?.active) return;
    try {
      const raw: unknown = JSON.parse(payload.toString());
      if (kind === 'command-results') {
        if (retained) return;
        const result = resultSchema.parse(raw);
        const command = this.repository.getCommand(result.commandId);
        if (
          !command ||
          command.deviceId !== deviceId ||
          result.credentialVersion !== device.credentialVersion ||
          result.credentialVersion !== command.credentialVersion ||
          result.connectionId !== command.connectionId ||
          Math.abs(result.timestamp - Date.now()) > RESULT_CLOCK_SKEW_MS ||
          command.result
        )
          return;
        this.repository.saveCommand({
          ...command,
          status: result.status,
          result,
          reason: result.reason,
        });
        this.notify(deviceId);
        return;
      }
      if (kind === 'state') {
        const state = stateSchema.parse(raw);
        if (
          state.credentialVersion !== device.credentialVersion ||
          state.timestamp > Date.now() + 5000
        )
          return;
        if (
          state.parameters.some(
            (value) =>
              !device.parameters[value.id] ||
              !acceptsValue(device.parameters[value.id]!, value.value),
          )
        )
          return;
        const previous = this.repository.getControl(deviceId).state;
        if (
          previous &&
          previous.credentialVersion === state.credentialVersion &&
          (state.timestamp < previous.timestamp ||
            (state.connectionId === previous.connectionId &&
              state.revision < previous.revision))
        )
          return;
        this.repository.saveControl(deviceId, 'state', state);
        this.confirmByRevision(deviceId, state);
        this.notify(deviceId);
      } else if (kind === 'availability') {
        const availability = availabilitySchema.parse(raw);
        if (
          availability.credentialVersion !== device.credentialVersion ||
          availability.timestamp > Date.now() + 5000
        )
          return;
        const previous = this.repository.getControl(deviceId).availability;
        // A Will is prepared at connect time, not at disconnect time.
        if (
          previous &&
          previous.credentialVersion === availability.credentialVersion &&
          availability.connectionId !== previous.connectionId &&
          availability.timestamp < previous.timestamp
        )
          return;
        if (
          previous &&
          availability.online &&
          availability.connectionId === previous.connectionId &&
          availability.timestamp < previous.timestamp
        )
          return;
        this.repository.saveControl(deviceId, 'availability', availability);
        if (!availability.online) this.live.delete(deviceId);
        else if (
          !retained &&
          Date.now() - availability.timestamp < CONTROL_FRESH_MS
        )
          this.live.set(deviceId, {
            connectionId: availability.connectionId,
            seenAt: Date.now(),
          });
        this.notify(deviceId);
      }
    } catch {
      /* Invalid device messages never alter control state. */
    }
  }
  /**
   * The device bumps its revision exactly once per applied command, and a
   * rejected command leaves it untouched. So an advancing state from the same
   * connection proves the command ran, even when its result packet was lost.
   */
  private confirmByRevision(deviceId: string, state: DeviceState): void {
    for (const command of this.repository.listCommands(deviceId)) {
      if (
        (command.status === 'pending' || command.status === 'unknown') &&
        command.connectionId === state.connectionId &&
        command.revision < state.revision
      ) {
        const confirmed: StoredCommand = { ...command, status: 'succeeded' };
        delete confirmed.reason;
        this.repository.saveCommand(confirmed);
      }
    }
  }
  issue(deviceId: string, input: unknown): StoredCommand {
    const parsed = commandInputSchema.safeParse(input);
    if (!parsed.success) throw new ControlError(400, 'Invalid command');
    const existing = this.repository.getCommand(parsed.data.commandId);
    if (existing) {
      if (
        existing.deviceId !== deviceId ||
        existing.parameterId !== parsed.data.parameterId ||
        existing.value !== parsed.data.value
      )
        throw new ControlError(409, 'Command ID already used');
      this.repository.expireCommands();
      this.notify(deviceId);
      return this.repository.getCommand(existing.commandId)!;
    }
    const snapshot = this.snapshot(deviceId);
    if (!snapshot.online || !snapshot.state || !this.publisher)
      throw new ControlError(
        409,
        'Device offline or state stale; commands are not queued',
      );
    if (
      snapshot.commands.some(
        (c) =>
          c.status === 'pending' ||
          (c.status === 'unknown' &&
            snapshot.state!.connectionId === c.connectionId &&
            snapshot.state!.timestamp <= c.expiresAt),
      )
    )
      throw new ControlError(
        409,
        'Previous command unresolved; wait for fresh actual state',
      );
    const parameter =
      this.repository.getDevice(deviceId)?.parameters[parsed.data.parameterId];
    if (
      !parameter ||
      !snapshot.state.parameters.some((p) => p.id === parameter.id) ||
      !acceptsValue(parameter, parsed.data.value)
    )
      throw new ControlError(400, 'Value does not match dashboard parameter');
    const now = Date.now();
    const command: Command = {
      ...parsed.data,
      credentialVersion: snapshot.state.credentialVersion,
      connectionId: snapshot.state.connectionId,
      revision: snapshot.state.revision,
      timestamp: now,
      expiresAt: now + COMMAND_TTL_MS,
    };
    const stored: StoredCommand = { ...command, deviceId, status: 'pending' };
    this.repository.saveCommand(stored);
    try {
      this.publisher(deviceId, command);
    } catch {
      this.repository.saveCommand({
        ...stored,
        status: 'unknown',
        reason: 'Transport failed; execution outcome unknown',
      });
    }
    this.notify(deviceId);
    return this.repository.getCommand(command.commandId)!;
  }
}
export class ControlError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
