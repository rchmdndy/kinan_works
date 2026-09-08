import type { NextFunction, Request, Response } from 'express';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import type { Repository } from './repository.js';

export type RequestUser = DecodedIdToken & { deviceId?: string; credentialVersion?: number };

declare global {
  namespace Express { interface Request { user?: RequestUser } }
}

export function userAuth(auth: Auth) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization');
      if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
      req.user = await auth.verifyIdToken(header.slice(7), true);
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }
  };
}

export function ownerOnly(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.deviceId) return res.status(403).json({ error: 'Owner authentication required' });
  next();
}

export function deviceOnly(repository: Repository) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const deviceId = req.user?.deviceId;
    if (!deviceId || !req.user?.credentialVersion) return res.status(403).json({ error: 'Device authentication required' });
    const access = await repository.getAccess(deviceId);
    if (!access || !access.active || access.credentialVersion !== req.user.credentialVersion) return res.status(401).json({ error: 'Device credential is inactive' });
    next();
  };
}
