import { buildExportTable, safeExportName } from './export-data';
import type { Device, TelemetryPacket } from './types';

const DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';

export async function exportTelemetry(device: Device, samples: TelemetryPacket[], start: Date, end: Date, parameterIds: string[]): Promise<void> {
  const [XLSX, { saveAs }] = await Promise.all([import('xlsx'), import('file-saver')]);
  const table = buildExportTable(device, samples, start, end, parameterIds);
  const dataSheet = XLSX.utils.aoa_to_sheet([table.headers, ...table.rows], { cellDates: true });
  const infoSheet = XLSX.utils.aoa_to_sheet([
    ['parameterId', 'label', 'unit', 'points', 'note'],
    ...table.info
  ]);
  for (let row = 1; row <= table.rows.length; row += 1) {
    const dateCell = dataSheet[XLSX.utils.encode_cell({ r: row, c: 0 })];
    if (dateCell) dateCell.z = DATE_FORMAT;
    for (let column = 0; column < table.numberFormats.length; column += 1) {
      const valueCell = dataSheet[XLSX.utils.encode_cell({ r: row, c: column + 1 })];
      if (valueCell?.t === 'n') valueCell.z = table.numberFormats[column];
    }
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, dataSheet, 'Data');
  XLSX.utils.book_append_sheet(workbook, infoSheet, 'Informasi');
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  saveAs(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${safeExportName(device.label)}-telemetry.xlsx`);
}
