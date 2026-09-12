type Bounds = { min?: number; max?: number; points: number };

export function validTarget(value: string, bounds: Bounds): boolean {
  const number = Number(value);
  return (
    value.trim() !== '' &&
    Number.isFinite(number) &&
    Number.isFinite(bounds.min) &&
    Number.isFinite(bounds.max) &&
    bounds.min! < bounds.max! &&
    number >= bounds.min! &&
    number <= bounds.max!
  );
}

export function stepTarget(
  value: string,
  actual: unknown,
  bounds: Bounds,
  direction: -1 | 1,
): string | null {
  if (
    !Number.isFinite(bounds.min) ||
    !Number.isFinite(bounds.max) ||
    bounds.min! >= bounds.max!
  )
    return null;
  const points = Math.max(0, Math.min(10, Math.trunc(bounds.points) || 0));
  const current = value.trim() === '' ? actual : Number(value);
  if (typeof current !== 'number' || !Number.isFinite(current)) return null;
  const next = Number((current + direction * 10 ** -points).toFixed(points));
  return String(Math.min(bounds.max!, Math.max(bounds.min!, next)));
}
