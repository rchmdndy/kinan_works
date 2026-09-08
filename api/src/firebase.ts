import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase, type Database } from 'firebase-admin/database';
import type { Config } from './config.js';

export function initializeFirebase(config: Config, serviceAccount: Record<string, unknown>) {
  const app = getApps()[0] ?? initializeApp({ credential: cert(serviceAccount), databaseURL: config.FIREBASE_DATABASE_URL });
  return { auth: getAuth(app), db: getDatabase(app) as Database };
}

export type FirebaseServices = ReturnType<typeof initializeFirebase>;
