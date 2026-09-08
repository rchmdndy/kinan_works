import type { NextFunction, Request, Response } from 'express';

type Entry = { count: number; resetAt: number };

export function rateLimit(windowMs: number, max: number, identify: (req: Request) => string = (req) => req.ip || 'unknown') {
  const entries = new Map<string, Entry>();
  let lastSweep = 0;
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (now - lastSweep >= windowMs) {
      for (const [key, value] of entries) if (value.resetAt <= now) entries.delete(key);
      lastSweep = now;
    }
    const key = identify(req);
    const current = entries.get(key);
    if (!current || current.resetAt <= now) entries.set(key, { count: 1, resetAt: now + windowMs });
    else current.count += 1;
    const entry = entries.get(key)!;
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', Math.max(0, max - entry.count));
    res.setHeader('RateLimit-Reset', Math.ceil(entry.resetAt / 1000));
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}
