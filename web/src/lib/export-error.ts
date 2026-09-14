export function formatExportError(error: string | null): string {
  if (!error) return 'Ekspor gagal di server.';
  if (error.startsWith('ENOENT') || error.includes('no such file or directory'))
    return 'File ekspor tidak ditemukan di server. Buat ulang ekspor.';
  if (error.length > 200) return `${error.slice(0, 200)}…`;
  return error;
}
