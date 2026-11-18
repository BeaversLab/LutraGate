import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { findPresetProvider } from "@lutragate/shared";
import type { AccessKeyRow, AdminApi, LogRow, ProviderRow, UserRow } from "../lib/api";
import type { LogStore } from "../lib/logstore";
import { buildAdminCanvas, SEVEN_DAYS_MS } from "../lib/canvas-aggregate";
import { LOG_SYNC_EVENT } from "../hooks/useLogSync";
import { GatewayCanvas } from "./GatewayCanvas";

/**
 * 管理总览画布容器（UI 2.0 #12）：数据 = 现有 admin API（供应商/用户/访问 Key）
 * + 本地镜像日志（7 天窗口聚合走 canvas-aggregate 纯函数）。日志重读挂
 * LOG_SYNC_EVENT（各面板 useLogSync 完成后派发）——画布自身不建同步循环。
 * 汇总条（summaryline）口径 = 近 7 天。零后端改动。
 */
export function AdminOverviewCanvas({
  api,
  db,
  onViewLogs,
}: {
  api: AdminApi;
  db: LogStore;
  onViewLogs?: () => void;
}) {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [accessKeys, setAccessKeys] = useState<AccessKeyRow[]>([]);

  useEffect(() => {
    // 列表面：失败不阻塞画布（空列表 → 零流量节点仍可渲染）。
    api.listProviders().then(setProviders).catch(() => setProviders([]));
    api.listUsers().then(setUsers).catch(() => setUsers([]));
    api.listAccessKeys().then(setAccessKeys).catch(() => setAccessKeys([]));
    const readLogs = () => {
      // ts 下推（logstore 契约）：只读 7 天窗口，长库存量不再全量拉回。
      db.listLogs(Date.now() - SEVEN_DAYS_MS).then(setLogs).catch(() => setLogs([]));
    };
    readLogs();
    window.addEventListener(LOG_SYNC_EVENT, readLogs);
    return () => window.removeEventListener(LOG_SYNC_EVENT, readLogs);
  }, [api, db]);

  const data = useMemo(() => {
    const userName = (id: string) => users.find((u) => u.id === id)?.name ?? id;
    const providerGroup = (p: ProviderRow) =>
      findPresetProvider(p.type)?.vendor ?? t("canvas.customGroup");
    return buildAdminCanvas(
      logs,
      accessKeys.map((k) => ({ id: k.id, name: `${k.name}（****${k.key_hint}）`, group: userName(k.user_id) })),
      providers.map((p) => ({ id: p.id, name: p.name, group: providerGroup(p) })),
      Date.now(),
    );
  }, [logs, accessKeys, providers, users, t]);

  // 减少动效偏好只读一次（系统设置切换需刷新生效，与 demo 口径一致）。
  const reducedMotion = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  return (
    <section>
      <div className="summaryline">
        <label>
          {t("canvas.inputsLabel")}
          <span className="number">{data.inputs.length}</span>
        </label>
        <label>
          {t("canvas.outputsLabel")}
          <span className="number">{data.outputs.length}</span>
        </label>
        <label>
          {t("canvas.sevenDayRequests")}
          <span className="number">{data.gateway.total}</span>
        </label>
        <div className="spacer" />
        <span className="pill">{t("canvas.sevenDayPill")}</span>
      </div>
      <GatewayCanvas data={data} reducedMotion={reducedMotion} onViewLogs={onViewLogs} />
    </section>
  );
}
