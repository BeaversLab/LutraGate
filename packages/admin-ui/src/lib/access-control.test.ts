import { describe, expect, it } from "vitest";
import {
  credentialStatus,
  dateInputToExpiry,
  expiryToDateInput,
  formatExpiry,
  formatLastUsed,
  parseCidrList,
} from "./access-control";

const NOW = Date.parse("2026-11-10T12:00:00");
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("formatExpiry", () => {
  it("0 = 永不过期", () => {
    expect(formatExpiry(0, NOW)).toBe("永不过期");
  });

  it("future → 相对展示（分钟/小时/天，向上取整）", () => {
    expect(formatExpiry(NOW + 30 * MIN, NOW)).toBe("30 分钟后过期");
    expect(formatExpiry(NOW + 61 * MIN, NOW)).toBe("2 小时后过期");
    expect(formatExpiry(NOW + 3 * DAY, NOW)).toBe("3 天后过期");
  });

  it("past → 已过期 N", () => {
    expect(formatExpiry(NOW - 2 * DAY, NOW)).toBe("已过期 2 天");
    expect(formatExpiry(NOW, NOW)).toBe("已过期 不到 1 分钟"); // now ≥ expires_at 即过期
  });
});

describe("formatLastUsed", () => {
  it("0 = 从未使用；近段时间相对展示；超 30 天退回日期", () => {
    expect(formatLastUsed(0, NOW)).toBe("从未使用");
    expect(formatLastUsed(NOW - 30 * MIN, NOW)).toBe("30 分钟前");
    expect(formatLastUsed(NOW - 5 * HOUR, NOW)).toBe("5 小时前");
    expect(formatLastUsed(NOW - 3 * DAY, NOW)).toBe("3 天前");
    expect(formatLastUsed(NOW - 40 * DAY, NOW)).toBe(new Date(NOW - 40 * DAY).toLocaleDateString());
  });
});

describe("credentialStatus", () => {
  // UI 2.0 #19：返回稳定枚举（展示文案由 StatusBadge 经 i18n 渲染）。
  const cases: Array<[string, Parameters<typeof credentialStatus>[0], string]> = [
    ["enabled and never expires", { enabled: true, expires_at: 0 }, "active"],
    ["disabled", { enabled: false, expires_at: 0 }, "disabled"],
    ["expired wins over disabled", { enabled: false, expires_at: NOW - 1 }, "expired"],
    ["owner cascade wins over everything", { enabled: true, expires_at: 0, ownerEnabled: false }, "owner_disabled"],
  ];
  it.each(cases)("%s → %s", (_name, input, expected) => {
    expect(credentialStatus({ now: NOW, ...input })).toBe(expected);
  });
});

describe("date ↔ epoch", () => {
  it("round-trips a chosen date to end-of-day local expiry", () => {
    const expiry = dateInputToExpiry("2026-11-20");
    expect(expiry).toBe(Date.parse("2026-11-20T23:59:59.999"));
    expect(expiryToDateInput(expiry)).toBe("2026-11-20");
  });

  it("empty = 0（永不过期）；非法 = -1（拦截）", () => {
    expect(dateInputToExpiry("")).toBe(0);
    expect(dateInputToExpiry("  ")).toBe(0);
    expect(dateInputToExpiry("not-a-date")).toBe(-1);
  });

  it("0 → 空输入值", () => {
    expect(expiryToDateInput(0)).toBe("");
  });
});

describe("parseCidrList", () => {
  it("multi-line: trims, drops blanks, dedupes", () => {
    expect(parseCidrList("10.0.0.0/8\n\n  2001:db8::/32  \n10.0.0.0/8\n")).toEqual({
      list: ["10.0.0.0/8", "2001:db8::/32"],
      error: null,
    });
  });

  it("empty text = empty list（= 不限）", () => {
    expect(parseCidrList("\n  \n")).toEqual({ list: [], error: null });
  });

  it.each([
    ["10.0.0.0/33"],
    ["not-a-cidr"],
    ["192.168.1.5"],          // 无前缀
    ["2001:db8::/129"],
  ])("intercepts invalid CIDR %s", (line) => {
    const parsed = parseCidrList(line);
    expect(parsed.error).toContain(line);
    expect(parsed.list).toBeNull();
  });
});
