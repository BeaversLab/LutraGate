import { describe, expect, it } from "vitest";
import { ipInCidrs, isValidCidr, parseCidr, parseIp } from "./cidr";

// 双栈 CIDR 矩阵（access-control 01）：精确命中 / 网段 / 规范化（主机位
// 清零）/ 跨族不匹配，全部走公共入口。

describe("isValidCidr", () => {
  it.each([
    ["192.168.1.0/24"],
    ["10.0.0.0/8"],
    ["0.0.0.0/0"],
    ["203.0.113.7/32"],
    ["2001:db8::/32"],
    ["::1/128"],
    ["::/0"],
    ["fe80::/10"],
    ["::ffff:192.0.2.0/120"],
  ])("accepts %s", (cidr) => {
    expect(isValidCidr(cidr)).toBe(true);
  });

  it.each([
    ["192.168.1.0"],          // 无前缀
    ["192.168.1.0/"],         // 空前缀
    ["192.168.1.0/xx"],       // 非数字前缀
    ["192.168.1.0/33"],       // v4 前缀越界
    ["2001:db8::/129"],       // v6 前缀越界
    ["192.168.1.256/24"],     // 八位组越界
    ["192.168.1/24"],         // v4 少一段
    ["2001:db8:::/32"],       // 多重冒号
    ["2001:db8::1::/32"],     // 双压缩
    ["2001:db8::1%eth0/64"],  // zone id
    ["not-an-ip/8"],
    ["/24"],                  // 只有前缀
  ])("rejects %s", (cidr) => {
    expect(isValidCidr(cidr)).toBe(false);
  });
});

describe("parseCidr (前缀规范化)", () => {
  it("clears host bits: 192.168.1.5/24 → 192.168.1.0/24", () => {
    const normalized = parseCidr("192.168.1.5/24");
    expect(normalized).toEqual(parseCidr("192.168.1.0/24"));
  });

  it("normalizes IPv6 host bits: 2001:db8::dead:beef/32 → 2001:db8::/32", () => {
    expect(parseCidr("2001:db8::dead:beef:1/32")).toEqual(parseCidr("2001:db8::/32"));
  });

  it("maps IPv4 CIDRs into the v4-mapped v6 space", () => {
    const rule = parseCidr("1.2.3.0/24");
    expect(rule).not.toBeNull();
    expect(rule!.family).toBe("ipv4");
    expect(rule!.network).toBe(parseCidr("::ffff:1.2.3.0/120")!.network);
  });
});

describe("ipInCidrs (双栈匹配矩阵)", () => {
  it.each([
    // IPv4：精确 / 网段 / 全网。
    ["192.168.1.10", ["192.168.1.10/32"]],
    ["192.168.1.200", ["192.168.1.0/24"]],
    ["8.8.8.8", ["0.0.0.0/0"]],
    // 规范化：非整八位组边界的前缀（/25）。
    ["10.1.2.3", ["10.1.2.0/25"]],
    // IPv6：精确 / 网段（压缩与大小写不敏感）。
    ["2001:db8::1", ["2001:db8::1/128"]],
    ["2001:DB8::ab", ["2001:db8::/32"]],
    ["fe80::1234:5678", ["fe80::/10"]],
    // 全网与回环。
    ["2620:0:2d0:200::7", ["::/0"]],
    ["::1", ["::1/128"]],
    // 嵌入式 IPv4 书写与等价映射形式互通。
    ["::ffff:192.0.2.9", ["192.0.2.0/24"]],
    // 多条列表命中其一。
    ["172.16.5.5", ["10.0.0.0/8", "172.16.0.0/12"]],
  ])("%s ∈ %s", (ip, cidrs) => {
    expect(ipInCidrs(ip, cidrs)).toBe(true);
  });

  it.each([
    // 网段外。
    ["192.168.2.1", ["192.168.1.0/24"]],
    ["10.1.2.130", ["10.1.2.0/25"]],
    // 跨族：IPv4 地址不落 IPv6 网段（及反向）。
    ["192.168.1.1", ["2001:db8::/32"]],
    ["2001:db8::1", ["192.168.0.0/16"]],
    // 普通 IPv6 单播地址不落 v4-mapped 段（::ffff:0:0/96 只覆盖映射形式）。
    ["2001:db8::1", ["::ffff:0:0/96"]],
    // 非法 IP 永不命中。
    ["not-an-ip", ["0.0.0.0/0"]],
    // 空列表 = 不限之外的兜底 false（网关层先判空）。
    ["1.2.3.4", []],
  ])("%s ∉ %s", (ip, cidrs) => {
    expect(ipInCidrs(ip, cidrs)).toBe(false);
  });

  it("skips malformed list entries instead of failing the whole match", () => {
    expect(ipInCidrs("10.0.0.1", ["bogus/xx", "10.0.0.0/8"])).toBe(true);
  });
});

describe("parseIp", () => {
  it("rejects malformed addresses", () => {
    expect(parseIp("1.2.3")).toBeNull();
    expect(parseIp("1.2.3.4.5")).toBeNull();
    expect(parseIp("256.1.1.1")).toBeNull();
    expect(parseIp("2001:db8::1::2")).toBeNull();
    expect(parseIp("")).toBeNull();
  });
});
