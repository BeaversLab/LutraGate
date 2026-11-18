import type { ProviderKey } from "@lutragate/shared";

/**
 * Provider-key encryption (spec §3.4): AES-GCM, 256-bit key from the
 * ENCRYPTION_KEY secret (base64). Ciphertext layout base64(iv(12B) ||
 * ciphertext || tag(16B)); the WebCrypto append the 16B tag after the
 * ciphertext, matching the format. Decryption happens only at forward time;
 * plaintext never leaves the request path.
 */

const IV_BYTES = 12;

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Import the ENCRYPTION_KEY secret (base64, 32 bytes) as an AES-GCM key. */
export async function importEncryptionKey(secretBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(secretBase64);
  if (raw.byteLength !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${raw.byteLength}`);
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt a plaintext API key to base64(iv|ciphertext|tag). */
export async function encryptApiKey(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const payload = new Uint8Array(iv.byteLength + encrypted.byteLength);
  payload.set(iv, 0);
  payload.set(new Uint8Array(encrypted), iv.byteLength);
  return bytesToBase64(payload);
}

/** Decrypt a base64(iv|ciphertext|tag) provider key. */
export async function decryptApiKey(key: CryptoKey, payloadBase64: string): Promise<string> {
  const payload = base64ToBytes(payloadBase64);
  const iv = payload.subarray(0, IV_BYTES);
  const ciphertext = payload.subarray(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

export type KeyResolver = (key: ProviderKey) => Promise<string> | string;

/**
 * Resolver used on the forward path: AES-GCM decrypt when ENCRYPTION_KEY is
 * configured (D1-stored keys); legacy atob for the tracer-bullet
 * GATEWAY_CONFIG path (ticket 04), which stores base64 plaintext.
 */
export function createKeyResolver(encryptionKey: CryptoKey | null): KeyResolver {
  if (encryptionKey === null) {
    return (key) => atob(key.encrypted_key);
  }
  return (key) => decryptApiKey(encryptionKey, key.encrypted_key);
}
