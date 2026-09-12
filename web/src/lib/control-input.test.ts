import { expect, test } from 'bun:test';
import { stepTarget, validTarget } from './control-input';

const bounds = { min: 0, max: 100, points: 1 };

test('targets reject empty, nonfinite, invalid bounds and out-of-range drafts', () => {
  for (const value of ['', ' ', 'NaN', 'Infinity', '-1', '101'])
    expect(validTarget(value, bounds)).toBe(false);
  for (const value of ['0', '100', '42.5'])
    expect(validTarget(value, bounds)).toBe(true);
  expect(validTarget('2', { points: 0 })).toBe(false);
  expect(validTarget('2', { min: 2, max: 2, points: 0 })).toBe(false);
});

test('stepper respects precision, bounds and actual state without publishing', () => {
  expect(stepTarget('0.2', 0, bounds, 1)).toBe('0.3');
  expect(stepTarget('0.3', 0, bounds, -1)).toBe('0.2');
  expect(stepTarget('', 42, bounds, 1)).toBe('42.1');
  expect(stepTarget('100', 0, bounds, 1)).toBe('100');
  expect(stepTarget('0', 0, bounds, -1)).toBe('0');
  expect(stepTarget('NaN', 0, bounds, 1)).toBeNull();
  expect(stepTarget('', undefined, bounds, 1)).toBeNull();
  expect(stepTarget('', true, bounds, 1)).toBeNull();
  expect(
    stepTarget('5', 0, { min: 0, max: Infinity, points: 0 }, 1),
  ).toBeNull();
  expect(stepTarget('0.0000000002', 0, { min: 0, max: 1, points: 10 }, 1)).toBe(
    '3e-10',
  );
  expect(stepTarget('0', 0, { min: -1, max: 1, points: 0 }, -1)).toBe('-1');
});
