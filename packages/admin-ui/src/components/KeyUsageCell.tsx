import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PROVIDER_USAGE_TYPES } from "@lutragate/core";
import { ApiError, type AdminApi, type KeyRow, type KeyUsageBody } from "../lib/api";
import { i18n } from "../i18n";

/**
 * 套餐窗口配额（provider-usage 04，key 级）：Key 行内的用量区。统一配额条渲染
 * （阈值 70% 黄 / 90% 红 + 重置时间 + 数据时间），per-provider 的数据差异已由
 * 服务端 adapter 归一化，这里只认 KeyUsageBody 一种形态。用量是上游账号维度的，
 * key 是账号身份的代理——凭证与用量都挂 key（02 的 provider 级已在 04 修订）。
 * 前端按 key 缓存（切走回来不重拉）；「刷新」按钮带 refresh=1 同时绕过前端缓存
 * 与服务端 TTL。查询失败灰字呈现不报红；不支持的供应商类型整格不渲染。
 */

/** 前端缓存：key = key id。跨面板切换存活，服务端另有 ~5 分钟 TTL。 */
const usageCache = new Map<string, KeyUsageBody>();

/** 纯函数用的翻译器（UI 2.0 #15 i18n）：默认全局 i18next 实例（测试固定 zh），
 * 组件内经 useTranslation 传入当前语言；插值变量刻意避开 count（防复数键解析）。 */
export type Translator = (key: string, opts?: Record<string, unknown>) => string;
const globalT: Translator = (key, opts) => i18n.t(key, opts ?? {}) as string;

/** 70% 黄 / 90% 红的填充色 class；其余走默认主色。 */
export function usageFillClass(percentage: number): string {
  if (percentage >= 90) return "usage-fill danger";
  if (percentage >= 70) return "usage-fill warn";
  return "usage-fill";
}

/** 最早重置时间（供「最早重置 …」文案）；全部窗口都缺 reset_at 时返回 null。 */
export function earliestResetAt(windows: Array<{ reset_at?: number }>): number | null {
  const times = windows.map((w) => w.reset_at).filter((t): t is number => t !== undefined);
  return times.length > 0 ? Math.min(...times) : null;
}

/** 数据时间相对文案：「刚刚」/「N 分钟前」/「N 小时前」。 */
export function formatFetchedAgo(fetchedAt: number, now: number, t: Translator = globalT): string {
  const minutes = Math.max(0, Math.floor((now - fetchedAt) / 60_000));
  if (minutes < 1) return t("keys.usage.justNow");
  if (minutes < 60) return t("keys.usage.minutesAgo", { n: minutes });
  return t("keys.usage.hoursAgo", { n: Math.floor(minutes / 60) });
}

/** 重置时间相对文案：「N 分钟 / 小时 / 天后重置」。 */
export function formatResetAt(resetAt: number, now: number, t: Translator = globalT): string {
  const diff = resetAt - now;
  if (diff <= 0) return t("keys.usage.resetSoon");
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return t("keys.usage.resetInMinutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("keys.usage.resetInHours", { n: hours });
  return t("keys.usage.resetInDays", { n: Math.floor(hours / 24) });
}

export function KeyUsageCell({
  api,
  keyRow,
  providerType,
  onSetupCredentials,
  now = () => Date.now(),
}: {
  api: AdminApi;
  /** 只用 id 拉用量（dash-status 02 起个人盘也用——上游 grant 视图非完整 KeyRow）。 */
  keyRow: Pick<KeyRow, "id">;
  /** 该 key 所属供应商的 preset type（adapter 分发维度）。 */
  providerType: string;
  /** 火山档没填 AK/SK 时引导按钮的回调（打开 key 凭证编辑）。 */
  onSetupCredentials?: () => void;
  now?: () => number;
}) {
  const { t } = useTranslation();
  // TFunction 泛型签名与纯函数注入点（Translator）之间做一层收窄包装。
  const translate: Translator = (key, opts) => t(key, opts ?? {});
  const supported = (PROVIDER_USAGE_TYPES as readonly string[]).includes(providerType);
  const [data, setData] = useState<KeyUsageBody | null>(() => usageCache.get(keyRow.id) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [noCredentials, setNoCredentials] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const body = await api.getKeyUsage(keyRow.id, { refresh });
        usageCache.set(keyRow.id, body);
        setData(body);
        setNoCredentials(false);
      } catch (err) {
        // 服务端专用错误码分流：类型不支持 → 整格不渲染（与本地判断双保险）；
        // 缺管控面凭证 → 引导态（不灰字报错）。
        if (err instanceof ApiError && err.code === "USAGE_UNSUPPORTED") {
          setUnsupported(true);
        } else if (err instanceof ApiError && err.code === "USAGE_NO_CREDENTIALS") {
          setNoCredentials(true);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setLoading(false);
      }
    },
    [api, keyRow.id],
  );

  useEffect(() => {
    if (supported && data === null) void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时拉一次；缓存命中不重拉
  }, [supported]);

  if (!supported || unsupported) return null;

  if (noCredentials) {
    return (
      <div className="usage-cell">
        <span className="usage-error">{t("keys.usage.setupHint")}</span>
        {onSetupCredentials && (
          <button className="usage-refresh" onClick={onSetupCredentials}>
            {t("keys.usage.setupAction")}
          </button>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="usage-cell">
        <span className="usage-error">{t("keys.usage.unavailable", { message: error })}</span>
        <button className="usage-refresh" onClick={() => void load(true)} disabled={loading}>
          {t("keys.usage.refresh")}
        </button>
      </div>
    );
  }

  if (data === null) {
    return (
      <span className="usage-error">{loading ? t("keys.usage.loading") : ""}</span>
    );
  }

  const current = now();
  return (
    <div className="usage-cell">
      {data.plan && <span className="usage-meta">{data.plan}</span>}
      {data.windows.map((w) => (
        <div className="usage-row" key={w.key}>
          <span className="usage-label" title={w.absolute}>{w.label}</span>
          <span className="usage-track">
            <span
              className={usageFillClass(w.percentage)}
              style={{ width: `${Math.min(100, Math.max(0, w.percentage))}%` }}
              data-testid={`usage-fill-${w.key}`}
            />
          </span>
          <span className="usage-pct">{w.percentage}%</span>
          {w.absolute && <span className="usage-absolute">{w.absolute}</span>}
        </div>
      ))}
      <div className="usage-meta">
        {formatFetchedAgo(data.fetched_at, current, translate)}
        {(() => {
          const earliest = earliestResetAt(data.windows);
          return earliest !== null
            ? ` · ${t("keys.usage.earliestReset", { time: formatResetAt(earliest, current, translate) })}`
            : "";
        })()}
        <button className="usage-refresh" onClick={() => void load(true)} disabled={loading}>
          {loading ? t("keys.usage.refreshing") : t("keys.usage.refresh")}
        </button>
      </div>
    </div>
  );
}
