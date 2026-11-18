/**
 * 双栈 CIDR 匹配器（access-control，roadmap v1.2）：纯 TS 手写 IPv4+IPv6
 * 解析、前缀规范化与逐位比较，零依赖。地址统一映射进 128 位空间比较——
 * IPv4 记作 IPv4-mapped IPv6（::ffff:a.b.c.d），因此 IPv4 CIDR 与其映射
 * 形式天然互通。核心不拥有 IP 来源：adapter 解析、core 匹配。
 */

/** 已规范化的 CIDR：网络地址（主机位已清零）与合法前缀长度。 */
export interface ParsedCidr {
  /** 128 位网络地址（IPv4 为 ::ffff:a.b.c.d 映射，主机位已清零）。 */
  network: bigint;
  /** 前缀位数（0-128）。 */
  prefix: number;
  /** 地址族，用于回显与诊断。 */
  family: "ipv4" | "ipv6";
}

/** 单个 IPv4 点分十进制 → 32 位（BigInt 0..2^32）；非法返回 null。 */
function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/** IPv4 → ::ffff:0:0/96 映射（128 位）。 */
function toMappedV4(value: bigint): bigint {
  return 0xffffn << 32n | value;
}

/**
 * 单个 IPv6 文本 → 128 位；非法返回 null。支持 "::" 压缩与尾部嵌入式
 * IPv4（如 ::ffff:192.0.2.1）；不支持 zone id（%eth0）。
 */
function parseIpv6(text: string): bigint | null {
  if (text.includes("%")) return null;
  // 尾部 IPv4 段：折算成两个 hextet 后继续按纯十六进制解析。
  let normalized = text;
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.includes(".")) {
    const tail = text.slice(lastColon + 1);
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const high = (v4 >> 16n).toString(16);
    const low = (v4 & 0xffffn).toString(16);
    normalized = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const expand = (half: string): bigint[] | null => {
    if (half === "") return [];
    const groups = half.split(":");
    const values: bigint[] = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      values.push(BigInt(`0x${group}`));
    }
    return values;
  };
  if (halves.length === 2) {
    const head = expand(halves[0]!);
    const tail = expand(halves[1]!);
    if (head === null || tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    const groups = [...head, ...Array<bigint>(missing).fill(0n), ...tail];
    return groups.reduce((acc, g) => (acc << 16n) | g, 0n);
  }
  const groups = expand(halves[0]!);
  if (groups === null || groups.length !== 8) return null;
  return groups.reduce((acc, g) => (acc << 16n) | g, 0n);
}

/** 解析单个 IP（不带前缀）为 128 位映射形式；非法返回 null。 */
export function parseIp(text: string): { value: bigint; family: "ipv4" | "ipv6" } | null {
  if (text.includes(":")) {
    const value = parseIpv6(text);
    return value === null ? null : { value, family: "ipv6" };
  }
  const v4 = parseIpv4(text);
  return v4 === null ? null : { value: toMappedV4(v4), family: "ipv4" };
}

/** 前缀位掩码（128 位空间）：IPv4 前缀要加上 96 位的 ::ffff:0:0/96 前导。 */
function prefixMask(family: "ipv4" | "ipv6", prefix: number): bigint {
  const bits = BigInt(family === "ipv4" ? prefix + 96 : prefix);
  const hostBits = 128n - bits;
  return hostBits === 128n ? 0n : ((1n << bits) - 1n) << hostBits;
}

/**
 * 解析 CIDR（"addr/prefix"）：解析地址与前缀长度，并把主机位清零
 * （前缀规范化，如 192.168.1.5/24 → 192.168.1.0/24）。非法返回 null——
 * 管理面据此 400，网关面据此跳过该条目。
 */
export function parseCidr(cidr: string): ParsedCidr | null {
  const slash = cidr.indexOf("/");
  if (slash === -1) return null;
  const ip = parseIp(cidr.slice(0, slash));
  if (ip === null) return null;
  const prefixText = cidr.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  const maxPrefix = ip.family === "ipv4" ? 32 : 128;
  if (prefix > maxPrefix) return null;
  return { network: ip.value & prefixMask(ip.family, prefix), prefix, family: ip.family };
}

/** 非法 CIDR 检测（管理面写入校验用）。 */
export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null;
}

/** IP 是否命中任一 CIDR（先各自规范化，再比较前缀位）。 */
export function ipInCidrs(ip: string, cidrs: readonly string[]): boolean {
  const parsed = parseIp(ip);
  if (parsed === null) return false;
  for (const cidr of cidrs) {
    const rule = parseCidr(cidr);
    if (rule === null) continue;
    const mask = prefixMask(rule.family, rule.prefix);
    if ((parsed.value & mask) === (rule.network & mask)) return true;
  }
  return false;
}

/** ip_allowlist 列（JSON 字符串数组）→ 字符串数组；坏 JSON 视为不限。 */
export function parseIpAllowlist(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}
