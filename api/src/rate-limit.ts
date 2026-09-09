type Entry = { count: number; resetAt: number };

export type RateLimitResult = {
  headers: Record<string, string>;
  limited: boolean;
};

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private lastSweep = 0;

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  check(identifier: string): RateLimitResult {
    const now = Date.now();
    if (now - this.lastSweep >= this.windowMs) {
      for (const [key, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(key);
      }
      this.lastSweep = now;
    }

    const current = this.entries.get(identifier);
    if (!current || current.resetAt <= now) {
      this.entries.set(identifier, { count: 1, resetAt: now + this.windowMs });
    } else {
      current.count += 1;
    }

    const entry = this.entries.get(identifier)!;
    const headers: Record<string, string> = {
      'RateLimit-Limit': String(this.max),
      'RateLimit-Remaining': String(Math.max(0, this.max - entry.count)),
      'RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
    };
    if (entry.count > this.max)
      headers['Retry-After'] = String(
        Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      );
    return { headers, limited: entry.count > this.max };
  }
}

export function clientAddress(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}
