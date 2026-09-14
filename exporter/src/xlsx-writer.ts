import * as XLSX from 'xlsx';

export type ExportParameter = {
  id: string;
  label: string;
  unit: string;
  points: number;
};

const DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';

export type ExportTable = {
  headers: string[];
  rows: Array<Array<string | number | Date>>;
  info: Array<Array<string | number>>;
  numberFormats: string[];
};

export function numberFormat(points: number): string {
  return points ? `0.${'0'.repeat(points)}` : '0';
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

export function buildTableHeader(parameters: ExportParameter[]): {
  headers: string[];
  numberFormats: string[];
  info: Array<Array<string | number>>;
} {
  return {
    headers: [
      'timestamp',
      ...parameters.map((parameter) =>
        parameter.unit
          ? `${parameter.label} (${parameter.unit})`
          : parameter.label,
      ),
    ],
    numberFormats: parameters.map((parameter) =>
      numberFormat(parameter.points),
    ),
    info: parameters.map((parameter) => [
      parameter.id,
      parameter.label,
      parameter.unit,
      parameter.points,
      'Metadata terbaru diterapkan; perubahan satuan tidak mengonversi nilai histori.',
    ]),
  };
}

export function buildWorkbookBytes(table: ExportTable): Uint8Array {
  const dataSheet = XLSX.utils.aoa_to_sheet([table.headers, ...table.rows], {
    cellDates: true,
  });
  const infoSheet = XLSX.utils.aoa_to_sheet([
    ['parameterId', 'label', 'unit', 'points', 'note'],
    ...table.info,
  ]);
  for (let row = 1; row <= table.rows.length; row += 1) {
    const dateCell = dataSheet[XLSX.utils.encode_cell({ r: row, c: 0 })];
    if (dateCell) dateCell.z = DATE_FORMAT;
    for (let column = 0; column < table.numberFormats.length; column += 1) {
      const valueCell =
        dataSheet[XLSX.utils.encode_cell({ r: row, c: column + 1 })];
      if (valueCell?.t === 'n') valueCell.z = table.numberFormats[column];
    }
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, dataSheet, 'Data');
  XLSX.utils.book_append_sheet(workbook, infoSheet, 'Informasi');
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Uint8Array(bytes as ArrayBuffer);
}
