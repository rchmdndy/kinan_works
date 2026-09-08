import { expect, test } from 'bun:test';
import { lastTelemetrySamples } from './telemetry';
import type { TelemetryPacket } from './types';

const packet = (timestamp: number): TelemetryPacket => ({ timestamp, values: {} });

test('lastTelemetrySamples orders by timestamp and keeps only the newest 10', () => {
  const samples = Object.fromEntries([11, 2, 7, 1, 10, 3, 9, 5, 6, 4, 8].map((timestamp) => [`sample-${timestamp}`, packet(timestamp)]));
  expect(lastTelemetrySamples(samples).map((sample) => sample.timestamp)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});
