import { expect, test } from 'bun:test';
import {
  changeParameterType,
  hasDeviceDraftErrors,
  normalizeDeviceDraft,
  validateDeviceDraft,
} from './device-form';

test('device draft validates bounds and normalizes API payload', () => {
  const invalid = validateDeviceDraft(' ', [
    { label: '', unit: 'x'.repeat(33), points: 1.5 },
  ]);
  expect(hasDeviceDraftErrors(invalid)).toBe(true);
  expect(invalid).toEqual({
    label: 'Nama perangkat wajib diisi.',
    parameter: [
      {
        label: 'Label wajib diisi.',
        unit: 'Satuan maksimal 32 karakter.',
        points: 'Gunakan bilangan bulat 0–10.',
      },
    ],
  });
  expect(
    normalizeDeviceDraft(' Stasiun ', [
      { label: ' Suhu ', unit: ' °C ', points: 2 },
    ]),
  ).toEqual({
    label: 'Stasiun',
    parameters: [{ type: 'nilai', label: 'Suhu', unit: '°C', points: 2 }],
  });
});

test('device draft requires at least one parameter', () => {
  const errors = validateDeviceDraft('Stasiun', []);
  expect(errors.parameters).toBe('Tambahkan minimal satu parameter.');
});

test('parameter type changes reset incompatible fields', () => {
  const parameter = {
    type: 'control-setpoint' as const,
    label: 'Target suhu',
    unit: '°C',
    points: 2,
    min: 10,
    max: 40,
  };

  expect(changeParameterType(parameter, 'control-state')).toEqual({
    type: 'control-state',
    label: 'Target suhu',
    unit: '',
    points: 0,
  });
  expect(changeParameterType(parameter, 'nilai')).toEqual({
    type: 'nilai',
    label: 'Target suhu',
    unit: '°C',
    points: 2,
  });
  expect(
    changeParameterType(
      { type: 'control-state', label: 'Pompa', unit: '', points: 0 },
      'control-setpoint',
    ),
  ).toEqual({
    type: 'control-setpoint',
    label: 'Pompa',
    unit: '',
    points: 0,
    min: 0,
    max: 1,
  });
});
