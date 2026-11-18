import type { AdminApi } from "./api";
import type { LogStore } from "./logstore";

/**
 * 增量日志同步（ticket 11，spec §3.7）：每 5 分钟或手动触发。
 *
 * 正常路径：从本地最大 ts 起增量拉取（from 含等值，重复行由主键幂等
 * 覆盖），页间用 cursor 续拉直到拉完。
 *
 * 积压路径：单次同步页数达到上限时，把当前游标持久化为 resumeCursor；
 * 下次同步从该游标继续拉取历史积压（不带 from），拉完后再恢复正常
 * 增量——避免"永远拉不完旧数据"的静默缺口。
 */

export interface SyncResult {
  /** 新写入的行数（库里原本不存在的 id）。 */
  inserted: number;
  /** 拉取的页数。 */
  pages: number;
  /** 达到单次页数上限，仍有历史积压待下次续拉。 */
  truncated: boolean;
}

const PAGE_LIMIT = 100;
const MAX_PAGES_PER_SYNC = 100; // 单次上限 1 万条，防失控

export async function syncLogsOnce(api: AdminApi, db: LogStore): Promise<SyncResult> {
  const resumeCursor = (await db.getMeta<string | null>("resumeCursor")) ?? null;
  const resuming = resumeCursor !== null;
  const maxTs = resuming ? 0 : await db.maxTs();

  let cursor: string | undefined = resuming ? resumeCursor ?? undefined : undefined;
  let inserted = 0;
  let pages = 0;
  let truncated = false;

  for (;;) {
    if (pages >= MAX_PAGES_PER_SYNC) {
      truncated = true;
      break;
    }
    const page = await api.listLogs({
      from: maxTs > 0 ? maxTs : undefined,
      cursor,
      limit: PAGE_LIMIT,
    });
    pages += 1;
    if (page.logs.length > 0) {
      // 幂等写入：已存在的 id 覆盖，返回真正新增数。
      inserted += await db.bulkPut(page.logs);
    }
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }

  await db.setMeta("resumeCursor", truncated ? (cursor ?? null) : null);
  await db.setMeta("lastSyncAt", Date.now());
  return { inserted, pages, truncated };
}
