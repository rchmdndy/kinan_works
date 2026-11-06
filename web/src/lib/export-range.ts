/** Local date + 24-hour clock, kept as strings so form controls bind directly. */
export type DateTimeParts = { date: string; hour: string; minute: string };
export type RangeErrors = { start?: string; end?: string };

export const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
export const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function toParts(timestamp: number): DateTimeParts {
  const d = new Date(timestamp);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hour: pad(d.getHours()),
    minute: pad(d.getMinutes()),
  };
}

/** Local-time timestamp, or null when any part is empty or not a real date. */
export function toTimestamp(parts: DateTimeParts): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts.date);
  if (!match || !/^\d{2}$/.test(parts.hour) || !/^\d{2}$/.test(parts.minute))
    return null;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const d = new Date(year, month - 1, day, hour, minute);
  const real =
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === day &&
    d.getHours() === hour &&
    d.getMinutes() === minute;
  return real ? d.getTime() : null;
}

export function validateRange(
  start: DateTimeParts,
  end: DateTimeParts,
  now: number,
): { start: number | null; end: number | null; errors: RangeErrors } {
  const startTs = toTimestamp(start);
  const endTs = toTimestamp(end);
  const errors: RangeErrors = {};
  if (startTs === null) errors.start = 'Isi tanggal, jam, dan menit mulai.';
  else if (startTs > now)
    errors.start = 'Waktu mulai tidak boleh melewati waktu sekarang.';
  if (endTs === null) errors.end = 'Isi tanggal, jam, dan menit akhir.';
  else if (startTs !== null && endTs <= startTs)
    errors.end =
      'Waktu akhir harus setelah waktu mulai. Untuk melewati tengah malam, pilih tanggal hari berikutnya.';
  return { start: startTs, end: endTs, errors };
}
