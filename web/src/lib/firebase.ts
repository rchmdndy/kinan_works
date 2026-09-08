import { initializeApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getDatabase, type Database } from 'firebase/database';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};
const missing = Object.entries(config).filter(([, value]) => !value || value === 'replace' || value.includes('YOUR_PROJECT')).map(([name]) => name);

export let auth: Auth | null = null;
export let database: Database | null = null;
export let firebaseSetupError = missing.length ? `Konfigurasi Firebase belum lengkap: ${missing.join(', ')}.` : '';

if (!firebaseSetupError) {
  try {
    const app = initializeApp(config);
    auth = getAuth(app);
    database = getDatabase(app);
  } catch (error) {
    firebaseSetupError = error instanceof Error ? `Firebase gagal dimuat: ${error.message}` : 'Firebase gagal dimuat.';
  }
}
