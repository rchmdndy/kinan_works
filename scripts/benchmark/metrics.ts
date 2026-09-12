import { readFileSync } from 'node:fs';
export const phases = ['baseline', 'devices10', 'devices20'] as const;
export function phase(ms: number) {
  return ms < 120000 ? phases[0] : ms < 420000 ? phases[1] : phases[2];
}
export function schedule() {
  return Array.from({ length: 20 }, (_, device) => {
    const start = device < 10 ? 120000 : 420000;
    // First ten retain their original cadence across the phase boundary.
    const offset = device < 10 ? device * 300 : (device - 10) * 300 + 150;
    return Array.from({ length: (600000 - start) / 3000 }, (_, sequence) => ({
      device,
      sequence,
      due: start + offset + sequence * 3000,
    }));
  })
    .flat()
    .sort((a, b) => a.due - b.due);
}
export function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (n: number) =>
    sorted.length
      ? sorted[Math.max(0, Math.ceil(n * sorted.length) - 1)]
      : null;
  return {
    count: sorted.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: sorted.at(-1) ?? null,
  };
}
function fields(path: string) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [key, value] = line.split(/\s+/);
        return [key, Number(value)];
      }),
  );
}
export type Counters = {
  cpuUsec: number;
  memoryBytes: number;
  readBytes: number;
  writeBytes: number;
  throttledUsec: number;
  oomKills: number;
};
export function counters(path: string): Counters {
  const cpu = fields(`${path}/cpu.stat`);
  const io = readFileSync(`${path}/io.stat`, 'utf8').trim().split('\n');
  let readBytes = 0,
    writeBytes = 0;
  for (const line of io)
    for (const token of line.split(/\s+/).slice(1)) {
      const [key, value] = token.split('=');
      if (key === 'rbytes') readBytes += Number(value);
      if (key === 'wbytes') writeBytes += Number(value);
    }
  return {
    cpuUsec: cpu.usage_usec,
    throttledUsec: cpu.throttled_usec ?? 0,
    memoryBytes: Number(readFileSync(`${path}/memory.current`, 'utf8')),
    readBytes,
    writeBytes,
    oomKills: fields(`${path}/memory.events`).oom_kill ?? 0,
  };
}
export function interval(
  previous: Counters,
  current: Counters,
  elapsedMs: number,
) {
  if (
    elapsedMs <= 0 ||
    current.cpuUsec < previous.cpuUsec ||
    current.readBytes < previous.readBytes ||
    current.writeBytes < previous.writeBytes
  )
    throw new Error('Resource counter reset or invalid sampling interval');
  return {
    cpuPercent: (current.cpuUsec - previous.cpuUsec) / (elapsedMs * 10),
    memoryBytes: current.memoryBytes,
    readBytesPerSecond:
      ((current.readBytes - previous.readBytes) * 1000) / elapsedMs,
    writeBytesPerSecond:
      ((current.writeBytes - previous.writeBytes) * 1000) / elapsedMs,
    throttledUsec: current.throttledUsec - previous.throttledUsec,
    oomKills: current.oomKills - previous.oomKills,
  };
}
export function verify(
  expected: { writeId: string; deviceId: string }[],
  rows: { write_id: string; device_id: string; count: number }[],
) {
  const key = (d: string, w: string) => `${d}/${w}`;
  const wanted = new Set(expected.map((v) => key(v.deviceId, v.writeId)));
  const found = new Map(
    rows.map((v) => [key(v.device_id, v.write_id), v.count]),
  );
  return {
    stored: expected.filter((v) => found.has(key(v.deviceId, v.writeId)))
      .length,
    missing: [...wanted].filter((v) => !found.has(v)),
    duplicates: rows.filter((v) => v.count > 1),
    unexpected: [...found.keys()].filter((v) => !wanted.has(v)),
  };
}
