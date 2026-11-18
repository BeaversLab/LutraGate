/** SecretStore：OS 安全存储缝（desktop 01）。注入风格同 StorageLike；Web 路径不创建实例（行为零变化）。 */
import { detectTauriInternals } from "./tauri";

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** SecretStore 只装 lgm_ 管理 token，不预留其他秘密类别（v1.3 spec 定稿）。
 * 例外：桌面闭源侧的授权凭证槽（license-credential，open-core #36）直接复用同一
 * Tauri secret_* 命令面，由闭源 bootstrap 读写——不经本接口，授权细节不出闭源仓。 */
export const MANAGEMENT_TOKEN_KEY = "management-token";

/**
 * 运行时探测 Tauri 环境（__TAURI_INTERNALS__，探测逻辑与 LogStore 共用在 tauri.ts）：
 * 探测不到返回 null 走 Web 路径，零构建期分叉（admin-ui 保持单一 Vite 构建）。
 */
export function detectSecretStore(
  internals?: Parameters<typeof detectTauriInternals>[0],
): SecretStore | null {
  const detected = detectTauriInternals(internals);
  if (detected === null) return null;
  return {
    get: (key) => detected.invoke("secret_get", { key }) as Promise<string | null>,
    set: (key, value) => detected.invoke("secret_set", { key, value }) as Promise<void>,
    delete: (key) => detected.invoke("secret_delete", { key }) as Promise<void>,
  };
}
