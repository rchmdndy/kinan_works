import { describe, expect, test } from 'bun:test';
import { devicePath, parseHashRoute } from './routes';

describe('hash routes', () => {
  test('parses each application route', () => {
    expect(parseHashRoute('#devices')).toEqual({ page: 'devices' });
    expect(parseHashRoute('#/devices/new')).toEqual({ page: 'new' });
    expect(parseHashRoute('#/devices/a%2Fb')).toEqual({ page: 'detail', id: 'a/b' });
    expect(parseHashRoute('#/devices/a/edit')).toEqual({ page: 'edit', id: 'a' });
    expect(parseHashRoute('#/devices/a/realtime')).toEqual({ page: 'realtime', id: 'a' });
    expect(parseHashRoute('#exports')).toEqual({ page: 'exports' });
  });

  test('falls back safely and encodes device paths', () => {
    expect(parseHashRoute('#unknown')).toEqual({ page: 'devices' });
    expect(devicePath('device/a')).toBe('/devices/device%2Fa');
    expect(devicePath('device/a', '/edit')).toBe('/devices/device%2Fa/edit');
  });
});
