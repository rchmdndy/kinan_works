import type { TelemetryPacket } from './types';

export function lastTelemetrySamples(value: Record<string, TelemetryPacket> | null, limit = 10): TelemetryPacket[] {
  return Object.values(value ?? {})
    .filter((sample) => Number.isFinite(sample?.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-limit);
}
