import * as XLSX from 'xlsx-js-style';

export type ExportParameter = {
  id: string;
  label: string;
  unit: string;
  points: number;
};

const DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';

// Excel stores dates as timezone-less serial numbers; SheetJS derives them
// from the writer's local time, which made exported times shift with the
// container timezone. Pin the display to WIB (UTC+7) instead: convert the
// epoch to the WIB wall clock and serialise that as if it were UTC, so the
// serial no longer depends on the writer's TZ.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const EPOCH_SERIAL = 25569; // serial of 1970-01-01 00:00:00

export function wibSerial(epochMs: number): number {
  return (epochMs + WIB_OFFSET_MS) / 86_400_000 + EPOCH_SERIAL;
}

export type SetpointHistoryRow = {
  sentAt: number;
  parameterId: string;
  label: string;
  target: number;
  unit: string;
  status: string;
  resultAt: number | '';
  reason: string;
  commandId: string;
  context: string;
};

export type ExportTable = {
  headers: string[];
  rows: Array<Array<string | number>>;
  info: Array<Array<string | number>>;
  numberFormats: string[];
  sensorColumnCount: number;
  setpointColumnCount: number;
  setpointHistory: SetpointHistoryRow[] | null;
  reportPeriod: { start: number; end: number } | null;
};

const SETPOINT_HEADERS = [
  'waktu dikirim',
  'parameterId',
  'parameter',
  'target',
  'satuan',
  'status perintah',
  'waktu hasil perangkat',
  'alasan',
  'commandId',
  'penanda konteks',
];

function formatUtc(timestamp: number): string {
  return new Date(timestamp).toISOString().replace('.000Z', 'Z');
}

export function formatWib(timestamp: number): string {
  return new Date(timestamp + WIB_OFFSET_MS)
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace('T', ' ');
}

function reportPeriodLabel({
  start,
  end,
}: NonNullable<ExportTable['reportPeriod']>): string {
  return `${formatWib(start)} – ${formatWib(end)} WIB (mulai inklusif, akhir eksklusif)`;
}

function setpointEmptyNote(
  period: NonNullable<ExportTable['reportPeriod']>,
): string {
  return `Tidak ada riwayat perintah setpoint untuk rentang ${reportPeriodLabel(period)}. Riwayat mencakup perintah yang dikirim dalam rentang tersebut serta konteks terakhir yang berhasil sebelum ${formatWib(period.start)} WIB bila tersedia.`;
}

function setpointInfoNote(
  period: NonNullable<ExportTable['reportPeriod']>,
): string {
  return `Waktu ditampilkan dalam WIB (UTC+7). Rentang laporan adalah ${reportPeriodLabel(period)}. Kolom Set Point di Data hanya mencatat perintah berstatus succeeded pada baris waktu perintah dikirim; sel berikutnya dibiarkan kosong dan tidak pernah diisi maju. Baris peristiwa tanpa telemetri dipertahankan dengan kolom sensor kosong. Status succeeded hanya mengonfirmasi perangkat menerima perintah, bukan stabilitas fisik. Perubahan lokal perangkat tidak dicatat sebagai riwayat perintah; metadata parameter terbaru tersedia di sheet Informasi. Baris konteks adalah perintah sukses terakhir sebelum ${formatWib(period.start)} WIB untuk tiap parameter dan bukan jaminan keadaan aktual saat ini.`;
}

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

export function buildTableHeader(
  parameters: ExportParameter[],
  setpoints: ExportParameter[] = [],
): {
  headers: string[];
  numberFormats: string[];
  info: Array<Array<string | number>>;
} {
  const columnLabel = (parameter: ExportParameter, prefix = '') =>
    `${prefix}${parameter.label}${parameter.unit ? ` (${parameter.unit})` : ''}`;
  const allParameters = [...parameters, ...setpoints];
  return {
    headers: [
      'timestamp',
      ...parameters.map((parameter) => columnLabel(parameter)),
      ...setpoints.map((parameter) => columnLabel(parameter, 'Set Point ')),
    ],
    numberFormats: allParameters.map((parameter) =>
      numberFormat(parameter.points),
    ),
    info: allParameters.map((parameter) => [
      parameter.id,
      parameter.label,
      parameter.unit,
      parameter.points,
      'Metadata terbaru diterapkan; perubahan satuan tidak mengonversi nilai histori.',
    ]),
  };
}

function styleTable(
  sheet: XLSX.WorkSheet,
  headerCount: number,
  rowCount: number,
  dateColumns: number[],
  numberFormats: string[] = [],
  numberStartColumn = 1,
): void {
  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
  range.e.c = Math.max(range.e.c, headerCount - 1);
  range.e.r = Math.max(range.e.r, rowCount);
  sheet['!ref'] = XLSX.utils.encode_range(range);
  sheet['!autofilter'] = {
    ref: `A1:${XLSX.utils.encode_col(headerCount - 1)}${Math.max(1, rowCount + 1)}`,
  };
  sheet['!cols'] = Array.from({ length: headerCount }, (_, index) => ({
    wch: index === 0 ? 22 : 18,
  }));
  sheet['!rows'] = [
    { hpt: 30 },
    ...Array.from({ length: rowCount }, () => ({ hpt: 20 })),
  ];
  for (let column = 0; column < headerCount; column += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: column })];
    if (!cell) continue;
    cell.s = {
      fill: { patternType: 'solid', fgColor: { rgb: '1B2A4A' } },
      font: { color: { rgb: 'FFFFFF' }, bold: true, name: 'Arial', sz: 11 },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    };
  }
  for (let row = 1; row <= rowCount; row += 1) {
    for (let column = 0; column < headerCount; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = sheet[address];
      if (!cell) continue;
      cell.s = {
        fill: {
          patternType: 'solid',
          fgColor: { rgb: row % 2 ? 'FFFFFF' : 'F7F7F5' },
        },
        font: { color: { rgb: '37352F' }, name: 'Arial', sz: 11 },
        alignment: {
          horizontal:
            column === 0 || dateColumns.includes(column) ? 'center' : 'right',
          vertical: 'center',
        },
      };
    }
    for (const column of dateColumns) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell) cell.z = DATE_FORMAT;
    }
    for (let column = 0; column < numberFormats.length; column += 1) {
      const cell =
        sheet[
          XLSX.utils.encode_cell({ r: row, c: numberStartColumn + column })
        ];
      if (cell?.t === 'n') cell.z = numberFormats[column];
    }
  }
}

export function buildWorkbookBytes(table: ExportTable): Uint8Array {
  // Date columns carry epoch-ms values; serialise them to the WIB wall clock
  // here so nothing downstream depends on the writer's timezone.
  const dataSheet = XLSX.utils.aoa_to_sheet([
    table.headers,
    ...table.rows.map((row) =>
      row.map((value, column) =>
        column === 0 && typeof value === 'number' ? wibSerial(value) : value,
      ),
    ),
  ]);
  const infoSheet = XLSX.utils.aoa_to_sheet([
    ['parameterId', 'label', 'unit', 'points', 'note'],
    ...table.info,
  ]);
  styleTable(
    dataSheet,
    table.headers.length,
    table.rows.length,
    [0],
    table.numberFormats,
  );
  styleTable(infoSheet, 5, table.info.length, []);
  infoSheet['!cols'] = [
    { wch: 22 },
    { wch: 24 },
    { wch: 12 },
    { wch: 10 },
    { wch: 54 },
  ];
  for (let row = 1; row <= table.info.length; row += 1) {
    const note = infoSheet[XLSX.utils.encode_cell({ r: row, c: 4 })];
    if (note?.s)
      note.s.alignment = {
        horizontal: 'left',
        vertical: 'center',
        wrapText: true,
      };
  }
  const setpointRows = table.setpointHistory?.length
    ? table.setpointHistory.map((row) => [
        wibSerial(row.sentAt),
        row.parameterId,
        row.label,
        row.target,
        row.unit,
        row.status,
        typeof row.resultAt === 'number' ? wibSerial(row.resultAt) : row.resultAt,
        row.reason,
        row.commandId,
        row.context,
      ])
    : table.setpointHistory
      ? [[setpointEmptyNote(table.reportPeriod!)]]
      : null;
  const setpointSheet = setpointRows
    ? XLSX.utils.aoa_to_sheet(
        [
          SETPOINT_HEADERS,
          ...setpointRows,
          [],
          [setpointInfoNote(table.reportPeriod!)],
        ],
      )
    : null;
  if (setpointSheet) {
    styleTable(
      setpointSheet,
      SETPOINT_HEADERS.length,
      Math.max(table.setpointHistory?.length ?? 0, 1),
      [0, 6],
      ['0.##########'],
      3,
    );
    setpointSheet['!cols'] = [
      { wch: 22 },
      { wch: 18 },
      { wch: 24 },
      { wch: 14 },
      { wch: 12 },
      { wch: 16 },
      { wch: 22 },
      { wch: 30 },
      { wch: 38 },
      { wch: 44 },
    ];
    for (let row = 1; row <= (table.setpointHistory?.length ?? 0); row += 1) {
      for (const column of [7, 8, 9]) {
        const cell =
          setpointSheet[XLSX.utils.encode_cell({ r: row, c: column })];
        if (cell?.s)
          cell.s.alignment = {
            horizontal: 'left',
            vertical: 'center',
            wrapText: true,
          };
      }
      setpointSheet['!rows']![row] = { hpt: 36 };
    }
    const noteRow = (table.setpointHistory?.length ?? 0) + 3;
    const note = setpointSheet[XLSX.utils.encode_cell({ r: noteRow, c: 0 })];
    if (note) {
      note.s = {
        font: { color: { rgb: '37352F' }, italic: true, name: 'Arial', sz: 10 },
        alignment: { horizontal: 'left', vertical: 'top', wrapText: true },
      };
      setpointSheet['!rows']![noteRow] = { hpt: 80 };
    }
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, dataSheet, 'Data');
  XLSX.utils.book_append_sheet(workbook, infoSheet, 'Informasi');
  if (setpointSheet)
    XLSX.utils.book_append_sheet(workbook, setpointSheet, 'Riwayat Setpoint');
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Uint8Array(bytes as ArrayBuffer);
}
