import type { Request, Response, NextFunction } from 'express';

type Entry = { count: number; resetAt: number };

export function rateLimit(windowMs: number, max: number) {
  const entries = new Map<string, Entry>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const current = entries.get(key);
    if (!current || current.resetAt <= now) entries.set(key, { count: 1, resetAt: now + windowMs });
    else current.count += 1;
    const entry = entries.get(key)!;
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', Math.max(0, max - entry.count));
    if (entry.count > max) return res.status(429).json({ error: 'Too many attempts' });
    next();
  };
}
