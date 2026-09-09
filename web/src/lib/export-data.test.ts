import { expect, test } from 'bun:test';
import { buildExportTable, formatReading, safeExportName } from './export-data';
import type { Device, TelemetryPacket } from './types';

const device: Device = {
  id: 'device',
  ownerUid: 'owner',
  label: '../Stasiun: Barat',
  active: true,
  credentialVersion: 1,
  createdAt: 0,
  updatedAt: 1,
  parameters: {
    temperature: {
      id: 'temperature',
      label: 'Suhu terbaru',
      unit: '°F',
      points: 2,
    },
    humidity: { id: 'humidity', label: 'Suhu terbaru', unit: '%', points: 0 },
  },
};
const samples: TelemetryPacket[] = [
  {
    timestamp: 999,
    values: {
      temperature: { status: 'ok', value: 1.234 },
      humidity: { status: 'ok', value: 7 },
    },
  },
  {
    timestamp: 1000,
    values: {
      temperature: { status: 'ok', value: 1.234 },
      humidity: { status: 'error', error: 'timeout' },
    },
  },
  {
    timestamp: 1999,
    values: {
      temperature: { status: 'error', error: 'offline' },
      humidity: { status: 'ok', value: 8 },
    },
  },
  {
    timestamp: 2000,
    values: {
      temperature: { status: 'ok', value: 9 },
      humidity: { status: 'ok', value: 9 },
    },
  },
];

test('export uses exclusive range, selected IDs, latest metadata, blanks for errors, and numeric formats', () => {
  const table = buildExportTable(
    device,
    samples,
    new Date(1000),
    new Date(2000),
    ['temperature', 'humidity'],
  );
  expect(table.headers).toEqual([
    'timestamp',
    'Suhu terbaru (°F)',
    'Suhu terbaru (%)',
  ]);
  expect(table.rows.map((row) => [row[1], row[2]])).toEqual([
    [1.234, ''],
    ['', 8],
  ]);
  expect(table.info[0]).toEqual([
    'temperature',
    'Suhu terbaru',
    '°F',
    2,
    'Metadata terbaru diterapkan; perubahan satuan tidak mengonversi nilai histori.',
  ]);
  expect(table.numberFormats).toEqual(['0.00', '0']);
  expect(formatReading(1.2, 2)).toBe('1,20');
  expect(safeExportName(device.label)).toBe('Stasiun-Barat');
});
