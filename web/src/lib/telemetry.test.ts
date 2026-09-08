import { expect, test } from 'bun:test';
import { connectTelemetryEvents, lastTelemetrySamples, mergeTelemetrySamples, parseTelemetryEvent, parseTelemetrySnapshot } from './telemetry';
import type { TelemetryPacket } from './types';

const packet = (timestamp: number, writeId?: string): TelemetryPacket => ({ timestamp, writeId, values: {} });

test('lastTelemetrySamples orders, deduplicates, and keeps only the newest 10', () => {
  const samples = Object.fromEntries([11, 2, 7, 1, 10, 3, 9, 5, 6, 4, 8].map((timestamp) => [`sample-${timestamp}`, packet(timestamp)]));
  expect(lastTelemetrySamples(samples).map((sample) => sample.timestamp)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  expect(mergeTelemetrySamples([packet(10, 'same')], [packet(10, 'same')])).toEqual([packet(10, 'same')]);
});

test('SSE payload parsers accept negotiated snapshot and telemetry shapes', () => {
  expect(parseTelemetrySnapshot(JSON.stringify({ latest: packet(3), last10: [packet(1), packet(2), packet(3)] }))).toEqual({
    latest: packet(3),
    last10: [packet(1), packet(2), packet(3)]
  });
  expect(parseTelemetrySnapshot(JSON.stringify({ data: { latest: packet(2), history: { first: packet(1), second: packet(2) } } }))).toEqual({
    latest: packet(2),
    last10: [packet(1), packet(2)]
  });
  expect(parseTelemetryEvent(JSON.stringify(packet(4)))).toEqual(packet(4));
  expect(parseTelemetryEvent(JSON.stringify({ packet: packet(5) }))).toEqual(packet(5));
  expect(parseTelemetrySnapshot('{')).toBeNull();
  expect(parseTelemetryEvent(JSON.stringify({ timestamp: 'bad', values: {} }))).toBeNull();
});

test('connectTelemetryEvents uses credentialed same-origin SSE and closes cleanly', () => {
  const listeners = new Map<string, (event: MessageEvent<string>) => void>();
  const states: string[] = [];
  const snapshots: unknown[] = [];
  const packets: TelemetryPacket[] = [];
  let requestedUrl = '';
  let requestedInit: EventSourceInit | undefined;
  let closed = false;
  const source = {
    onopen: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { listeners.set(type, listener); },
    close() { closed = true; }
  };

  const stop = connectTelemetryEvents('device / one', {
    snapshot: (value) => snapshots.push(value),
    telemetry: (value) => packets.push(value),
    state: (value) => states.push(value)
  }, (url, init) => {
    requestedUrl = url;
    requestedInit = init;
    return source;
  });

  expect(requestedUrl).toBe('/api/devices/device%20%2F%20one/events');
  expect(requestedInit).toEqual({ withCredentials: true });
  expect(states).toEqual(['connecting']);
  source.onopen?.(new Event('open'));
  listeners.get('snapshot')?.({ data: JSON.stringify({ latest: packet(1), samples: [packet(1)] }) } as MessageEvent<string>);
  listeners.get('telemetry')?.({ data: JSON.stringify(packet(2)) } as MessageEvent<string>);
  source.onerror?.(new Event('error'));
  expect(states).toEqual(['connecting', 'open', 'error']);
  expect(snapshots).toHaveLength(1);
  expect(packets).toEqual([packet(2)]);
  stop();
  expect(closed).toBe(true);
});
