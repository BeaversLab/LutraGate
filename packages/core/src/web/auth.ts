/**
 * Gateway bearer-token auth (spec §3.5): constant-time comparison via
 * SHA-256 digests to prevent timing side channels.
 */

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const digest = (s: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) {
    diff |= va[i]! ^ vb[i]!;
  }
  return diff === 0;
}
