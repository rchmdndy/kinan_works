import { describe, expect, test } from 'bun:test';
import { formatExportError } from './export-error';

describe('formatExportError', () => {
  test('maps missing-file errors to a friendly message', () => {
    expect(
      formatExportError(
        "ENOENT: no such file or directory, chmod '/data/exports/Grow-Sense.xlsx'",
      ),
    ).toBe('File ekspor tidak ditemukan di server. Buat ulang ekspor.');
    expect(
      formatExportError(
        "Error: ENOENT: no such file or directory, open '/data/exports/x.xlsx'",
      ),
    ).toBe('File ekspor tidak ditemukan di server. Buat ulang ekspor.');
  });

  test('keeps other errors readable without leaking internals', () => {
    expect(
      formatExportError('Ekspor melebihi batas maksimum 1000000 baris.'),
    ).toBe('Ekspor melebihi batas maksimum 1000000 baris.');
    expect(formatExportError(null)).toBe('Ekspor gagal di server.');
  });

  test('truncates very long errors', () => {
    const long = 'x'.repeat(500);
    const result = formatExportError(long);
    expect(result.length).toBe(201);
    expect(result.endsWith('…')).toBe(true);
  });
});
