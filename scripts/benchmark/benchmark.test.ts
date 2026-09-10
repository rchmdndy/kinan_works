import { expect, test } from 'bun:test';
import { bootstrapScript } from './stack';

test('bootstrap retries only an empty database with the matching operator', async () => {
  const password_hash = await Bun.password.hash('test-password');
  for (const [devices, telemetry, users, allowed] of [
    [0, 0, [], true],
    [0, 0, [{ username: 'benchmark', active: 1, password_hash }], true],
    [1, 0, [], false],
    [0, 1, [], false],
    [0, 0, [{ username: 'other', active: 1, password_hash }], false],
    [0, 0, [{ username: 'benchmark', active: 0, password_hash }], false],
    [
      0,
      0,
      [
        {
          username: 'benchmark',
          active: 1,
          password_hash: await Bun.password.hash('wrong'),
        },
      ],
      false,
    ],
  ] as const) {
    let inserts = 0;
    class Database {
      query(sql: string) {
        return {
          get: () => ({ n: sql.includes('devices') ? devices : telemetry }),
          all: () => users,
          run: () => {
            inserts++;
          },
        };
      }
      close() {}
    }
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    const run = new AsyncFunction('require', bootstrapScript('test-password'));
    if (allowed) {
      await run(() => ({ Database }));
      expect(inserts).toBe(users.length ? 0 : 1);
    } else {
      await expect(run(() => ({ Database }))).rejects.toThrow();
      expect(inserts).toBe(0);
    }
  }
});
import { distribution, interval, phase, schedule, verify } from './metrics';

test('exact 600 second schedule: baseline 120, ten 300, twenty 180', () => {
  const jobs = schedule();
  expect(jobs).toHaveLength(2200);
  expect(jobs.filter((j) => j.due < 120000)).toHaveLength(0);
  expect(jobs.filter((j) => j.due < 420000)).toHaveLength(1000);
  expect(jobs.filter((j) => j.due >= 420000)).toHaveLength(1200);
  expect(Math.max(...jobs.map((j) => j.due))).toBeLessThan(600000);
  for (let d = 0; d < 20; d++) {
    const device = jobs.filter((j) => j.device === d);
    expect(device).toHaveLength(d < 10 ? 160 : 60);
    for (let i = 1; i < device.length; i++)
      expect(device[i].due - device[i - 1].due).toBe(3000);
  }
  expect(
    new Set(
      jobs.filter((j) => j.due >= 420000 && j.due < 423000).map((j) => j.due),
    ).size,
  ).toBe(20);
  expect(phase(120000)).toBe('devices10');
  expect(phase(420000)).toBe('devices20');
});
test('nearest rank quantiles and empty latency are not fabricated zeros', () => {
  expect(distribution([]).p95).toBeNull();
  expect(distribution(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({
    count: 100,
    p50: 50,
    p95: 95,
    p99: 99,
    max: 100,
  });
});
test('resources use actual elapsed time and one-core CPU normalization', () => {
  const previous = {
    cpuUsec: 0,
    memoryBytes: 0,
    readBytes: 0,
    writeBytes: 0,
    throttledUsec: 0,
    oomKills: 0,
  };
  expect(
    interval(
      previous,
      { ...previous, cpuUsec: 2000000, memoryBytes: 100, writeBytes: 200 },
      2000,
    ),
  ).toMatchObject({
    cpuPercent: 100,
    memoryBytes: 100,
    writeBytesPerSecond: 100,
  });
  expect(() => interval({ ...previous, cpuUsec: 10 }, previous, 1000)).toThrow(
    'counter reset',
  );
});
test('verification distinguishes missing, duplicate and unexpected records', () => {
  const result = verify(
    [
      { deviceId: 'a', writeId: 'one' },
      { deviceId: 'b', writeId: 'two' },
    ],
    [
      { device_id: 'a', write_id: 'one', count: 2 },
      { device_id: 'a', write_id: 'other', count: 1 },
    ],
  );
  expect(result.stored).toBe(1);
  expect(result.missing).toEqual(['b/two']);
  expect(result.duplicates).toHaveLength(1);
  expect(result.unexpected).toEqual(['a/other']);
});
