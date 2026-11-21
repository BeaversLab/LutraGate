import { describe, expect, it } from "vitest";
// ?raw 先例：d1.test.ts 读迁移 SQL。配置守卫读 wrangler.jsonc 原文。
import wranglerConfigRaw from "../wrangler.jsonc?raw";

/**
 * 配置守卫（builtin-web 02，ADR-0004）：Workers 的静态资产由平台先于 worker 代码
 * 服务，SPA 回退（not_found_handling）会吞掉一切未命中资产又未被 run_worker_first
 * 圈住的路径。API 面（数据面 /v1、管理面 /admin、发布信息 /version、健康检查
 * /health——gateway handler 共享，worker 形态同样存在）必须永远先进 worker 代码。
 * 本测试锁住配置，防未来手改时 SPA 回退悄悄吞掉 API 路由。
 * /v1 与 /v1beta 是不同的路径段：Gemini 原生面（/v1beta/models/{model}:{method}）
 * 不会被 /v1/* 覆盖，必须单独圈住。
 */

/** 极简 JSONC 解析：跳过行/块注释，忽略字符串字面量内的注释符。 */
function parseJsonc(source: string): Record<string, unknown> {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out) as Record<string, unknown>;
}

const config = parseJsonc(wranglerConfigRaw);

describe("worker assets config guard (builtin-web 02)", () => {
  it("assets：目录指向 admin-ui dist，回退为 SPA 模式", () => {
    const assets = config.assets as Record<string, unknown> | undefined;
    expect(assets).toBeDefined();
    expect(assets!.directory).toBe("../admin-ui/dist");
    expect(assets!.not_found_handling).toBe("single-page-application");
  });

  it("run_worker_first 圈住全部 API 面：/v1、/admin、/version、/health（裸路径 + 子路径）", () => {
    const assets = config.assets as { run_worker_first?: string[] };
    const routes = assets.run_worker_first ?? [];
    // 每个端点：裸路径与子路径都必须命中（"/v1" 或 "/v1/*" 至少其一不行——两个都要，
    // 通配不保证匹配裸路径，裸路径不覆盖子路径）。
    for (const endpoint of ["/v1", "/v1beta", "/admin", "/version", "/health"]) {
      expect(
        routes.includes(endpoint),
        `run_worker_first 缺裸路径 ${endpoint}——SPA 回退会吞掉它`,
      ).toBe(true);
      expect(
        routes.includes(`${endpoint}/*`),
        `run_worker_first 缺通配 ${endpoint}/*——SPA 回退会吞掉子路径`,
      ).toBe(true);
    }
  });
});
