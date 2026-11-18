/**
 * 用户凭证工具（多用户 tickets 01/03）：管理 token（lgm_）与数据面访问
 * key（lgk_）的生成与哈希。明文凭证只在创建/重置响应中出现一次，库里只存
 * SHA-256 哈希；两个前缀的哈希集合天然不相交，构成管理面/数据面互斥的基础。
 */

/** SHA-256 哈希的 hex 表示（64 字符），用于凭证入库与查找。 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomBase64Url(bytes: number): string {
  let bin = "";
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 生成管理 token：lgm_ + 32 字节随机数的 base64url。 */
export function generateManagementToken(): string {
  return `lgm_${randomBase64Url(32)}`;
}

/** 生成数据面访问 key：lgk_ + 32 字节随机数的 base64url（ticket 03）。 */
export function generateAccessKey(): string {
  return `lgk_${randomBase64Url(32)}`;
}

/** 展示用尾 4 位提示（与 provider_key.key_hint 约定一致）。 */
export function tokenHint(token: string): string {
  return token.slice(-4);
}
