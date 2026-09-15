import * as XLSX from 'xlsx';

export type ExportParameter = {
  id: string;
  label: string;
  unit: string;
  points: number;
};

const DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';

export type SetpointHistoryRow = {
  sentAt: Date;
  parameterId: string;
  label: string;
  target: number;
  unit: string;
  status: string;
  resultAt: Date | '';
  reason: string;
  commandId: string;
  context: string;
};

export type ExportTable = {
  headers: string[];
  rows: Array<Array<string | number | Date>>;
  info: Array<Array<string | number>>;
  numberFormats: string[];
  setpointHistory: SetpointHistoryRow[] | null;
  reportPeriod: { start: Date; end: Date } | null;
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

function formatUtc(timestamp: Date): string {
  return timestamp.toISOString().replace('.000Z', 'Z');
}

function reportPeriodLabel({
  start,
  end,
}: NonNullable<ExportTable['reportPeriod']>): string {
  return `[${formatUtc(start)}, ${formatUtc(end)}) UTC (mulai inklusif, akhir eksklusif)`;
}

function setpointEmptyNote(
  period: NonNullable<ExportTable['reportPeriod']>,
): string {
  return `Tidak ada riwayat perintah setpoint untuk rentang ${reportPeriodLabel(period)}. Riwayat mencakup perintah yang dikirim dalam rentang tersebut serta konteks terakhir yang berhasil sebelum ${formatUtc(period.start)} UTC bila tersedia.`;
}

function setpointInfoNote(
  period: NonNullable<ExportTable['reportPeriod']>,
): string {
  return `Semua waktu berasal dari timestamp paket UTC. XLSX tidak menyimpan zona waktu, sehingga nilai tanggal/waktu ditulis untuk diinterpretasikan sebagai UTC. Rentang laporan adalah ${reportPeriodLabel(period)}. Status succeeded hanya mengonfirmasi perangkat menerima perintah, bukan stabilitas fisik. Perubahan lokal perangkat tidak dicatat sebagai riwayat perintah; metadata parameter terbaru tersedia di sheet Informasi. Baris konteks adalah perintah sukses terakhir sebelum ${formatUtc(period.start)} UTC untuk tiap parameter dan bukan jaminan keadaan aktual saat ini.`;
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
  const setpointRows = table.setpointHistory?.length
    ? table.setpointHistory.map((row) => [
        row.sentAt,
        row.parameterId,
        row.label,
        row.target,
        row.unit,
        row.status,
        row.resultAt,
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
        { cellDates: true },
      )
    : null;
  for (let row = 1; row <= (table.setpointHistory?.length ?? 0); row += 1) {
    const sentAt = setpointSheet![XLSX.utils.encode_cell({ r: row, c: 0 })];
    const resultAt = setpointSheet![XLSX.utils.encode_cell({ r: row, c: 6 })];
    const target = setpointSheet![XLSX.utils.encode_cell({ r: row, c: 3 })];
    if (sentAt) sentAt.z = DATE_FORMAT;
    if (resultAt) resultAt.z = DATE_FORMAT;
    if (target?.t === 'n') target.z = '0.##########';
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, dataSheet, 'Data');
  XLSX.utils.book_append_sheet(workbook, infoSheet, 'Informasi');
  if (setpointSheet)
    XLSX.utils.book_append_sheet(workbook, setpointSheet, 'Riwayat Setpoint');
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Uint8Array(bytes as ArrayBuffer);
}
