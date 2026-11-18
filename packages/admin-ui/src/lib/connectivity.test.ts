import { describe, expect, it } from "vitest";
import { formatLatency } from "./connectivity";

// 03 起连通性测试本体走服务端转发（POST /admin/providers/:id/test，行为在
// core/web/admin.ts 的 worker e2e 覆盖）；这里只剩展示辅助。
describe("formatLatency", () => {
  it("formats milliseconds and seconds", () => {
    expect(formatLatency(45)).toBe("45 ms");
    expect(formatLatency(1200)).toBe("1.20 s");
  });
});
