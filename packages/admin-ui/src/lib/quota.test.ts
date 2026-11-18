import { describe, expect, it } from "vitest";
import { formatLimit, localMidnight, parseLimitInput, remaining } from "./quota";

describe("quota display helpers (quota 03)", () => {
  it("formats 0 as 不限", () => {
    expect(formatLimit(0)).toBe("不限");
    expect(formatLimit(5000)).toBe("5,000");
  });

  it("computes remainder with the soft-wall overshoot clamped to 0; null = unlimited", () => {
    expect(remaining(3, 10)).toBe(7);
    expect(remaining(10, 10)).toBe(0); // 触发 429 后：余量 0
    expect(remaining(12, 10)).toBe(0); // token 软墙越限也钉 0
    expect(remaining(99, 0)).toBeNull(); // 不限
  });

  it("parses limit inputs leniently: empty/invalid/negative → 0 (=不限)", () => {
    expect(parseLimitInput("")).toBe(0);
    expect(parseLimitInput("50000")).toBe(50_000);
    expect(parseLimitInput("-3")).toBe(0);
    expect(parseLimitInput("1.5")).toBe(0);
    expect(parseLimitInput("abc")).toBe(0);
  });

  it("snaps to the local-midnight window start", () => {
    const midnight = localMidnight(new Date("2026-11-09T15:30:00").getTime());
    expect(midnight).toBe(new Date("2026-11-09T00:00:00").getTime());
    // 同日共享；跨日翻窗。
    expect(localMidnight(new Date("2026-11-09T00:00:01").getTime())).toBe(midnight);
    expect(localMidnight(new Date("2026-11-10T08:00:00").getTime())).toBe(midnight + 86_400_000);
  });
});
