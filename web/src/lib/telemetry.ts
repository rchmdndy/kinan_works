import type { TelemetryPacket } from './types';

export type TelemetrySnapshot = {
  latest: TelemetryPacket | null;
  last10: TelemetryPacket[];
};

export type TelemetryConnectionState = 'connecting' | 'open' | 'error';

type EventSourceLike = {
  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
};

type EventSourceFactory = (
  url: string,
  init: EventSourceInit,
) => EventSourceLike;

type TelemetryEventHandlers = {
  snapshot(snapshot: TelemetrySnapshot): void;
  telemetry(packet: TelemetryPacket): void;
  state(state: TelemetryConnectionState): void;
  malformed?(eventName: 'snapshot' | 'telemetry'): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTelemetryPacket(value: unknown): value is TelemetryPacket {
  if (
    !isRecord(value) ||
    !Number.isFinite(value.timestamp) ||
    !isRecord(value.values)
  )
    return false;
  return Object.values(value.values).every((reading) => {
    if (!isRecord(reading)) return false;
    return reading.status === 'ok'
      ? typeof reading.value === 'number' && Number.isFinite(reading.value)
      : reading.status === 'error' && typeof reading.error === 'string';
  });
}

function packetKey(packet: TelemetryPacket): string {
  return packet.writeId
    ? `write:${packet.writeId}`
    : `packet:${packet.timestamp}:${JSON.stringify(packet.values)}`;
}

export function lastTelemetrySamples(
  value: Record<string, TelemetryPacket> | TelemetryPacket[] | null,
  limit = 10,
): TelemetryPacket[] {
  const samples = Array.isArray(value) ? value : Object.values(value ?? {});
  const unique = new Map<string, TelemetryPacket>();
  for (const sample of samples) {
    if (isTelemetryPacket(sample)) unique.set(packetKey(sample), sample);
  }
  return [...unique.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-limit);
}

export function mergeTelemetrySamples(
  current: TelemetryPacket[],
  incoming: TelemetryPacket[],
  limit = 10,
): TelemetryPacket[] {
  return lastTelemetrySamples([...current, ...incoming], limit);
}

export function parseTelemetrySnapshot(data: string): TelemetrySnapshot | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) return null;
    const payload = isRecord(parsed.data) ? parsed.data : parsed;
    const latest =
      payload.latest == null
        ? null
        : isTelemetryPacket(payload.latest)
          ? payload.latest
          : null;
    if (payload.latest != null && !latest) return null;
    const candidateSamples = Array.isArray(payload.last10)
      ? payload.last10
      : Array.isArray(payload.samples)
        ? payload.samples
        : Array.isArray(payload.history)
          ? payload.history
          : isRecord(payload.history)
            ? Object.values(payload.history)
            : [];
    if (!candidateSamples.every(isTelemetryPacket)) return null;
    return { latest, last10: lastTelemetrySamples(candidateSamples, 10) };
  } catch {
    return null;
  }
}

export function parseTelemetryEvent(data: string): TelemetryPacket | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (isTelemetryPacket(parsed)) return parsed;
    if (isRecord(parsed) && isTelemetryPacket(parsed.packet))
      return parsed.packet;
    return null;
  } catch {
    return null;
  }
}

export function connectTelemetryEvents(
  deviceId: string,
  handlers: TelemetryEventHandlers,
  createEventSource: EventSourceFactory = (url, init) =>
    new EventSource(url, init),
): () => void {
  handlers.state('connecting');
  const source = createEventSource(
    `/api/devices/${encodeURIComponent(deviceId)}/events`,
    { withCredentials: true },
  );

  source.addEventListener('snapshot', (event) => {
    const snapshot = parseTelemetrySnapshot(event.data);
    if (snapshot) handlers.snapshot(snapshot);
    else handlers.malformed?.('snapshot');
  });
  source.addEventListener('telemetry', (event) => {
    const packet = parseTelemetryEvent(event.data);
    if (packet) handlers.telemetry(packet);
    else handlers.malformed?.('telemetry');
  });
  source.onopen = () => handlers.state('open');
  source.onerror = () => handlers.state('error');

  return () => source.close();
}
