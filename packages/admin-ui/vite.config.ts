import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 客户端版本注入（页脚右下角展示）：与服务器 /version 同一口径——HEAD 恰在 v* 标签
// 上取标签名，否则「最近标签+领先数」（v1.3.0+2）；无 git（罕见）回落 package.json。
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};
let appVersion = pkg.version;
try {
  // 去掉标签的 v 前缀：页脚统一补「v」渲染（package.json 回落值同理无前缀）。
  // stderr 吞掉：无 .git 的导出快照不应喷 `fatal: not a git repository`。
  appVersion = execSync("git describe --tags --exact-match HEAD", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim().replace(/^v/, "");
} catch {
  try {
    const long = execSync("git describe --tags --long --match 'v*' HEAD", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
    const ahead = /-(\d+)-g[0-9a-f]+$/.exec(long)?.[1] ?? "0";
    appVersion = `${long.replace(/-\d+-g[0-9a-f]+$/, "").replace(/^v/, "")}+${ahead}`;
  } catch {
    /* 无 git：保留 package.json 版本 */
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  test: {
    environment: "jsdom",
    globals: true, // enables @testing-library/react auto-cleanup
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
