import { expect, test } from 'bun:test';
import {
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
