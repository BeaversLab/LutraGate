const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** 21-char nanoid-compatible id (web-standard crypto only). */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  let id = "";
  for (const b of bytes) id += ALPHABET[b & 63];
  return id;
}
