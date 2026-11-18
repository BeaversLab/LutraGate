import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LogStore } from "../lib/logstore";
import { LOG_SYNC_EVENT } from "../hooks/useLogSync";
import { formatClock } from "../lib/format";

/**
 * 页脚本地同步状态条（UI 2.0 #11）：读取 LogStore 的 lastSyncAt meta
 * （syncLogsOnce 每次同步后写入）。只陈述「本地镜像最近一次同步时间」，
 * 不暗示网关实时在线健康（spec 故事 29）。
 * 刷新时机 = 挂载 + 各面板 useLogSync 完成后派发的 LOG_SYNC_EVENT——
 * 不做周期轮询：轮询会让 Dexie 连接常驻读写，与删除环境的整库删除竞态
 * （已删库可能被轮询读复活成空 schema 库）。
 */
export function SyncFooter({ db }: { db: LogStore | null }) {
  const { t } = useTranslation();
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  useEffect(() => {
    setLastSyncAt(null);
    if (db === null) return;
    let cancelled = false;
    const read = () => {
      void db
        .getMeta<number>("lastSyncAt")
        .then((value) => {
          if (!cancelled) setLastSyncAt(value ?? null);
        })
        .catch(() => {
          /* meta 读取失败（如桌面 IPC 异常）：保持「尚未同步」文案，不阻塞壳层。 */
        });
    };
    read();
    window.addEventListener(LOG_SYNC_EVENT, read);
    return () => {
      cancelled = true;
      window.removeEventListener(LOG_SYNC_EVENT, read);
    };
  }, [db]);

  return (
    <footer className="sync-footer">
      <span className="sync-dot" aria-hidden="true" />
      {lastSyncAt === null
        ? t("footer.neverSynced")
        : t("footer.syncedAt", { time: formatClock(lastSyncAt) })}
      {/* 客户端版本（右下角）：vite define 构建期注入（admin-ui package.json）。 */}
      <span className="app-version">v{__APP_VERSION__}</span>
    </footer>
  );
}
