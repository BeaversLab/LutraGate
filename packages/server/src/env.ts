/** Server configuration from environment variables (spec §3.5 server form). */
export interface ServerEnv {
  /** Admin token for /admin/* (required — no Cloudflare Access on this form). */
  adminToken: string;
  /** base64(32B) AES-GCM key for provider-key encryption (required). */
  encryptionKey: string;
  /** SQLite database file; default "lutragate.db". */
  dbPath: string;
  /** Comma-separated client IP allowlist for /admin/*; empty disables. */
  allowedIps: string[];
  /** HTTP port; default 8787. */
  port: number;
  /**
   * TLS 证书/私钥路径（自签名证书 HTTPS 形态）：两者必须同时给出，缺一启动报错；
   * 都不给 = 明文 HTTP（原行为）。证书 SAN 须覆盖客户端实际连接的主机名/IP
   * （WKWebView 正式版禁明文 HTTP 出站；走 HTTPS + 本机信任 CA 即满足 ATS）。
   */
  tlsCertPath: string | null;
  tlsKeyPath: string | null;
  /**
   * When true, the admin client IP is taken from the first X-Forwarded-For
   * hop (deploy behind a reverse proxy); otherwise unknown (null).
   */
  trustProxy: boolean;
}

function parsePort(raw: string | undefined): number {
  const port = Number.parseInt(raw ?? "8787", 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid PORT: ${raw}`);
  }
  return port;
}

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): ServerEnv {
  const adminToken = source.ADMIN_TOKEN;
  const encryptionKey = source.ENCRYPTION_KEY;
  const missing = (["ADMIN_TOKEN", "ENCRYPTION_KEY"] as const)
    .filter((name) => !source[name])
    .join(", ");
  if (missing) {
    throw new Error(`missing required environment variables: ${missing}`);
  }
  const tlsCertPath = source.TLS_CERT_PATH ?? null;
  const tlsKeyPath = source.TLS_KEY_PATH ?? null;
  if ((tlsCertPath === null) !== (tlsKeyPath === null)) {
    throw new Error("TLS_CERT_PATH and TLS_KEY_PATH must be set together");
  }
  return {
    adminToken: adminToken!,
    encryptionKey: encryptionKey!,
    dbPath: source.DB_PATH ?? "lutragate.db",
    allowedIps: (source.ALLOWED_IPS ?? "")
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean),
    port: parsePort(source.PORT),
    trustProxy: source.TRUST_PROXY === "1",
    tlsCertPath,
    tlsKeyPath,
  };
}
