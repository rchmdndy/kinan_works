import type { Device, TelemetryPacket } from './types';

export type ExportTable = {
  headers: string[];
  rows: Array<Array<string | number | Date>>;
  info: Array<Array<string | number>>;
  numberFormats: string[];
};

export function formatReading(value: number, points: number): string {
  return value.toLocaleString('id-ID', {
    minimumFractionDigits: points,
    maximumFractionDigits: points,
  });
}

export function numberFormat(points: number): string {
  return points ? `0.${'0'.repeat(points)}` : '0';
}

export function buildExportTable(
  device: Device,
  samples: TelemetryPacket[],
  start: Date,
  end: Date,
  parameterIds: string[],
): ExportTable {
  const parameters = parameterIds
    .map((id) => device.parameters[id])
    .filter(
      (parameter) =>
        parameter !== undefined && (parameter.type ?? 'nilai') === 'nilai',
    );
  return {
    headers: [
      'timestamp',
      ...parameters.map((parameter) =>
        parameter.unit
          ? `${parameter.label} (${parameter.unit})`
          : parameter.label,
      ),
    ],
    rows: samples
      .filter(
        (sample) =>
          sample.timestamp >= start.getTime() &&
          sample.timestamp < end.getTime(),
      )
      .map((sample) => [
        new Date(sample.timestamp),
        ...parameters.map((parameter) => {
          const reading = sample.values[parameter.id];
          return reading?.status === 'ok' ? reading.value : '';
        }),
      ]),
    info: parameters.map((parameter) => [
      parameter.id,
      parameter.label,
      parameter.unit,
      parameter.points,
      'Metadata terbaru diterapkan; perubahan satuan tidak mengonversi nilai histori.',
    ]),
    numberFormats: parameters.map((parameter) =>
      numberFormat(parameter.points),
    ),
  };
}

export function safeExportName(label: string): string {
  return (
    label
      .normalize('NFKD')
      .replaceAll(/[^a-z0-9_-]+/gi, '-')
      .replaceAll(/^-+|-+$/g, '')
      .slice(0, 80) || 'device'
  );
}
