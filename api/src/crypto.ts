import type { EncryptedSecret } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

export async function encryptSecret(secret: string, keyBytes: Uint8Array): Promise<EncryptedSecret> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(keyBytes), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(secret));
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

export async function decryptSecret(encrypted: EncryptedSecret, keyBytes: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(keyBytes), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(base64ToBytes(encrypted.iv)) },
    key,
    new Uint8Array(base64ToBytes(encrypted.ciphertext))
  );
  return decoder.decode(plaintext);
}

export function generateDeviceSecret(): string {
  return `${crypto.randomUUID().replaceAll('-', '')}${bytesToBase64(crypto.getRandomValues(new Uint8Array(18))).replaceAll(/[^a-zA-Z0-9]/g, '')}`;
}
