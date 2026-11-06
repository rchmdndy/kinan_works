import { describe, expect, test } from 'bun:test';
import { toParts, toTimestamp, validateRange } from './export-range';

const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();
const now = at(2026, 11, 6, 12, 0);
const p = (date: string, hour: string, minute = '00') => ({
  date,
  hour,
  minute,
});

describe('toTimestamp / toParts', () => {
  test('round-trips local time in 24-hour form', () => {
    const parts = toParts(at(2026, 11, 6, 0, 5));
    expect(parts).toEqual(p('2026-11-06', '00', '05'));
    expect(toTimestamp(parts)).toBe(at(2026, 11, 6, 0, 5));
    expect(toParts(at(2026, 11, 6, 23, 59)).hour).toBe('23');
  });
  test('rejects empty and impossible values', () => {
    expect(toTimestamp(p('', '10'))).toBeNull();
    expect(toTimestamp(p('2026-02-31', '10'))).toBeNull();
    expect(toTimestamp(p('2026-11-06', '24'))).toBeNull();
    expect(toTimestamp(p('2026-11-06', '10', '60'))).toBeNull();
    expect(toTimestamp(p('2026-11-06', ''))).toBeNull();
  });
});

describe('validateRange', () => {
  test('accepts a range that crosses midnight', () => {
    const r = validateRange(p('2026-11-05', '19'), p('2026-11-06', '06'), now);
    expect(r.errors).toEqual({});
    expect(r.start).toBe(at(2026, 11, 5, 19));
    expect(r.end).toBe(at(2026, 11, 6, 6));
  });
  test('rejects 00:00 on the start date (the reported case)', () => {
    const r = validateRange(p('2026-11-05', '19'), p('2026-11-05', '00'), now);
    expect(r.errors.start).toBeUndefined();
    expect(r.errors.end).toContain('setelah waktu mulai');
  });
  test('end must be strictly after start', () => {
    const same = validateRange(
      p('2026-11-05', '19'),
      p('2026-11-05', '19'),
      now,
    );
    expect(same.errors.end).toBeDefined();
    const later = validateRange(
      p('2026-11-05', '19'),
      p('2026-11-05', '19', '01'),
      now,
    );
    expect(later.errors).toEqual({});
  });
  test('start may equal now but not exceed it', () => {
    expect(
      validateRange(p('2026-11-06', '12'), p('2026-11-06', '13'), now).errors,
    ).toEqual({});
    expect(
      validateRange(p('2026-11-06', '12', '01'), p('2026-11-06', '13'), now)
        .errors.start,
    ).toContain('tidak boleh melewati waktu sekarang');
    expect(
      validateRange(p('2026-11-07', '00'), p('2026-11-08', '00'), now).errors
        .start,
    ).toBeDefined();
  });
  test('reports missing fields without a misleading end error', () => {
    const r = validateRange(p('', '10'), p('2026-11-06', '09'), now);
    expect(r.errors.start).toContain('Isi');
    expect(r.errors.end).toBeUndefined();
  });
});
