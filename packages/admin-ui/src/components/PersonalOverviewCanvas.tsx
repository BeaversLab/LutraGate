import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AccessKeyRow, AdminApi, Identity, LogRow } from "../lib/api";
import type { LogStore } from "../lib/logstore";
import { buildPersonalCanvas, SEVEN_DAYS_MS } from "../lib/canvas-aggregate";
import { LOG_SYNC_EVENT } from "../hooks/useLogSync";
import { GatewayCanvas } from "./GatewayCanvas";

/**
 * 个人总览画布容器（UI 2.0 #13）：入口 = 自己的 lgk_（administrator 切个人
 * 视角时 listAccessKeys 返回全局，客户端钉回自己的 user；user 角色服务端已
 * SQL 钉定），出口 = 上游模型（upstream_model 回退 client_model）——user
 * 角色无供应商列表权限，画布不携带供应商信息。日志按 user_id=自己过滤
 * （buildPersonalCanvas 数据层钉定，admin 的本地镜像含全量行也不越权）。
 * 汇总条与网关节点 = 自己的 7 天口径。既有个人统计见下方 MyDashboardPanel。
 */
export function PersonalOverviewCanvas({
  api,
  db,
  identity,
  onViewLogs,
}: {
  api: AdminApi;
  db: LogStore;
  /** 调用方保证有真实 user id（虚拟管理员无「自己」，视角门控下本页不可达）。 */
  identity: Identity & { id: string };
  onViewLogs?: () => void;
}) {
  const { t } = useTranslation();
  const userId = identity.id;
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [accessKeys, setAccessKeys] = useState<AccessKeyRow[]>([]);

  useEffect(() => {
    // key 名列表：失败不阻塞画布（空列表 → 零流量节点仍可渲染）。
    api.listAccessKeys().then(setAccessKeys).catch(() => setAccessKeys([]));
    const readLogs = () => {
      // ts 下推（logstore 契约）：只读 7 天窗口；user_id 过滤在纯函数层。
      db.listLogs(Date.now() - SEVEN_DAYS_MS).then(setLogs).catch(() => setLogs([]));
    };
    readLogs();
    window.addEventListener(LOG_SYNC_EVENT, readLogs);
    return () => window.removeEventListener(LOG_SYNC_EVENT, readLogs);
  }, [api, db]);

  const data = useMemo(() => {
    const ownKeys = accessKeys.filter((k) => k.user_id === userId);
    return buildPersonalCanvas(
      logs,
      ownKeys.map((k) => ({ id: k.id, name: `${k.name}（****${k.key_hint}）`, group: "" })),
      userId,
      Date.now(),
    );
  }, [logs, accessKeys, userId]);

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
          {t("canvas.outputModelColumn")}
          <span className="number">{data.outputs.length}</span>
        </label>
        <label>
          {t("canvas.sevenDayRequests")}
          <span className="number">{data.gateway.total}</span>
        </label>
        <div className="spacer" />
        <span className="pill">{t("canvas.sevenDayPill")}</span>
      </div>
      <GatewayCanvas data={data} variant="personal" reducedMotion={reducedMotion} onViewLogs={onViewLogs} />
    </section>
  );
}
