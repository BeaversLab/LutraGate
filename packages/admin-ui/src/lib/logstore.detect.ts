import { LogDb } from "./logdb";
import { clearAllDataSql, loadDesktopLogStore, sqliteDbUrl } from "./logstore.sqlite";
import type { LogStore } from "./logstore";
import { detectTauriInternals } from "./tauri";

/** Web Dexie 库名含 env id（spec「本地镜像分库」；旧库 lutragate 不读不写）。 */
export function dexieDbName(envId: string): string {
  return `lutragate-${envId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/**
 * 运行时探测选择本地镜像实现（desktop 03，零构建期分叉）：
 * Tauri 环境 → SQLite 私库（永久保留，spec D4）；Web → Dexie（IndexedDB）。
 * multi-env 01 起：库按 env id 命名，两套网关的镜像互不混合。
 */
export async function detectLogStore(
  envId: string,
  internals?: Parameters<typeof detectTauriInternals>[0],
): Promise<LogStore> {
  return detectTauriInternals(internals) === null
    ? new LogDb(dexieDbName(envId))
    : loadDesktopLogStore(envId);
}

/**
 * 清除环境的本地镜像数据（multi-env 04，spec「删除环境」）：
 * Web = 整库删除（Dexie `db.delete()`）；桌面 = tauri-plugin-sql 无删库能力 →
 * 按 spec 择「清空表数据」（clearAllDataSql：幂等建表 + DELETE 两表）。
 * 两形态验收断言同口径：删除后读取为空。
 */
export async function deleteLogStoreData(
  envId: string,
  internals?: Parameters<typeof detectTauriInternals>[0],
): Promise<void> {
  if (detectTauriInternals(internals) === null) {
    await new LogDb(dexieDbName(envId)).delete();
    return;
  }
  const { default: Database } = await import("@tauri-apps/plugin-sql");
  const db = await Database.load(sqliteDbUrl(envId));
  for (const sql of clearAllDataSql()) await db.execute(sql);
}
