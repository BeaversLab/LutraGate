import { readFileSync } from "node:fs";

/**
 * 发布信息（Server 形态专用）：部署时由 scripts/release-info.ts 在部署机生成
 * release-info.json，随 compose 卷挂载进容器（CWD 可读）。文件缺失/损坏时
 * 全部回退 null——/version 永远可应答，不因注入缺失而 5xx。
 */

export interface ReleaseInfo {
  /** 发布标签；HEAD 不在标签上时为「最近标签+领先数」形态（如 v1.3.0+2）。 */
  tag: string | null;
  /** HEAD 完整 commit hash。 */
  commit: string | null;
}

const EMPTY: ReleaseInfo = { tag: null, commit: null };

export function loadReleaseInfo(path?: string): ReleaseInfo {
  const target = path ?? process.env.RELEASE_INFO_PATH ?? "release-info.json";
  try {
    const raw = JSON.parse(readFileSync(target, "utf8")) as Partial<ReleaseInfo>;
    return {
      tag: typeof raw.tag === "string" && raw.tag.length > 0 ? raw.tag : null,
      commit: typeof raw.commit === "string" && raw.commit.length > 0 ? raw.commit : null,
    };
  } catch {
    // 文件缺失（本地开发 / 未注入部署）→ 空信息，接口仍 200。
    return EMPTY;
  }
}
