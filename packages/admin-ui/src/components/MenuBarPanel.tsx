import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, type AdminApi, type GrantRow, type Identity } from "../lib/api";
import {
  formatFetchedAgo,
  isUsageSupported,
  KeyUsageCell,
  usageFillClass,
  type Translator,
} from "./KeyUsageCell";
import { toErrorMessage } from "../lib/error";
import type { EnvRecord } from "../lib/envs";
import { showMainWindow } from "../lib/tauri";
import {
  availableScopes,
  loadMenuBarData,
  loadStoredScope,
  MENU_PANEL_SHOWN_EVENT,
  resolveScope,
  saveStoredScope,
  type KeyRisk,
  type MenuBarScope,
  type UsageLine,
  type UserGroup,
} from "../lib/menu-bar";

function UsageBar({ id, kind, line, label }: { id: string; kind: "tokens" | "requests"; line: UsageLine; label: string }) {
  return (
    <div className="menu-bar-usage">
      <span className="menu-bar-usage-label">{label}</span>
      <span className="usage-track">
        <span
          className={usageFillClass(line.percent)}
          data-testid={`menu-bar-fill-${id}-${kind}`}
          style={{ width: `${Math.min(100, Math.max(0, line.percent))}%` }}
        />
      </span>
      <span className="menu-bar-usage-value">
        {line.used.toLocaleString()} / {line.limit.toLocaleString()}（{Math.round(line.percent)}%）
      </span>
    </div>
  );
}

function RiskRow({ row }: { row: KeyRisk }) {
  const { t } = useTranslation();
  return (
    <li
      className={row.exceeded ? "menu-bar-row exceeded" : "menu-bar-row"}
      data-testid={`menu-bar-row-${row.id}`}
    >
      <div className="menu-bar-row-head">
        <strong>{row.name}</strong>
        <span className="hint">{t("menuBar.keyHint", { hint: row.keyHint })}</span>
        {row.exceeded && <span className="menu-bar-badge">{t("menuBar.exceeded")}</span>}
      </div>
      {row.tokens !== null && (
        <UsageBar id={row.id} kind="tokens" line={row.tokens} label={t("menuBar.tokens")} />
      )}
      {row.requests !== null && (
        <UsageBar id={row.id} kind="requests" line={row.requests} label={t("menuBar.requests")} />
      )}
    </li>
  );
}

function RiskList({ rows }: { rows: KeyRisk[] }) {
  return (
    <ol className="menu-bar-list">
      {rows.map((row) => <RiskRow key={row.id} row={row} />)}
    </ol>
  );
}

/**
 * 菜单栏面板（menu-bar-usage 03/04）：第二个隐藏 Webview 经
 * `index.html#menu-panel` 渲染本组件。数据来自 /admin/access-keys +
 * /admin/usage?group_by=key&today=1（服务端定义当日窗口，ADR-0005）。
 * administrator 可在「全局 / 自己」间切换并持久化；全局按用户分组；
 * 普通用户恒为自己；虚拟管理员只能全局。Rust 壳每次显示面板/托盘刷新时
 * 派发 DOM 事件，不依赖 Tauri JS 包。
 */
export function MenuBarPanel({
  api,
  identity,
  envName,
  credentialInvalid = false,
  environments = [],
  activeEnvId = null,
  onSwitchEnv,
}: {
  api: AdminApi | null;
  identity: Identity | null;
  envName: string;
  /** 管理 token 401：主窗口已标记凭证失效 → 面板给出重新登录引导。 */
  credentialInvalid?: boolean;
  /** 全部已登记环境：>1 时头部出现环境切换下拉（面板直接切环境，主窗口经 storage 跟随）。 */
  environments?: EnvRecord[];
  activeEnvId?: string | null;
  /** 与主窗口设置页同一条切换路径（写 localStorage + 重装凭证）。 */
  onSwitchEnv?: (envId: string) => void;
}) {
  const { t } = useTranslation();
  const translate: Translator = (key, opts) => t(key, opts ?? {});
  const [rows, setRows] = useState<KeyRisk[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [scope, setScope] = useState<MenuBarScope>(
    () => (identity === null ? "self" : resolveScope(identity, loadStoredScope(window.localStorage))),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  /** 面板自身观测到 401（不依赖 App 的 /admin/me 一次性判定）；换凭证后复位。 */
  const [reauth, setReauth] = useState(false);
  const scopes = identity === null ? [] : availableScopes(identity);

  useEffect(() => {
    setReauth(false);
  }, [api]);

  // 身份异步到达（启动时 getMe）后，按角色重算合法视角；持久化值仍受角色限制。
  useEffect(() => {
    if (identity !== null) setScope(resolveScope(identity, loadStoredScope(window.localStorage)));
  }, [identity]);

  const refresh = useCallback(async () => {
    // 身份到达前 / 视角尚在角色纠正中（如虚拟管理员从初始 self 收到 global）：
    // 跳过这一轮，避免发出角色不允许的查询。401 之后停止轮询等新凭证。
    if (reauth || api === null || identity === null || !availableScopes(identity).includes(scope)) return;
    setLoading(true);
    try {
      const data = await loadMenuBarData(api, identity, scope);
      setRows(data.risks);
      setGroups(data.groups);
      setError(null);
      setLastUpdatedAt(Date.now());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setReauth(true);
        setError(null);
        return;
      }
      // 保留上次成功数据：失败只标注，不清空（后续静置监视同口径）。
      setError(toErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api, identity, scope, reauth]);

  // 上游依赖段恒为「我的 grants」，与视角切换无关。虚拟管理员取 grants 会 400
  //（无 user_id）→ 从未成功过、列表为空 → 整段隐藏；普通失败保留上次成功列表。
  // 套餐窗口数据按 key 懒加载（KeyUsageCell，不自动轮询）。
  const loadGrants = useCallback(async () => {
    if (reauth) return;
    if (api === null || identity === null) {
      setGrants([]);
      return;
    }
    try {
      const result = await api.getMyGrants();
      setGrants(result.grants ?? []);
    } catch {
      // 保留上次成功数据；从未成功（如虚拟管理员）则保持空列表（整段隐藏）。
    }
  }, [api, identity, reauth]);

  // 面板每次显示/托盘刷新：场景段与上游 grants 列表都重拉；套餐窗口本身仍只
  // 走 KeyUsageCell 的缓存 + 手动刷新（不自动轮询外部 API）。面板可见时由自己
  // 每 60s 刷新（Rust tick 此时让位），隐藏窗口的定时器不承担监视职责。
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), loadGrants()]);
  }, [refresh, loadGrants]);

  useEffect(() => {
    void refreshAll();
    const onShown = () => { void refreshAll(); };
    window.addEventListener(MENU_PANEL_SHOWN_EVENT, onShown);
    // 只在窗口真正可见时自刷新；隐藏时让位给主窗口的 Rust tick，避免重复请求。
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshAll();
    }, 60_000);
    return () => {
      window.removeEventListener(MENU_PANEL_SHOWN_EVENT, onShown);
      window.clearInterval(timer);
    };
  }, [refreshAll]);

  const changeScope = (next: MenuBarScope) => {
    setScope(next);
    saveStoredScope(window.localStorage, next);
  };

  const hasRows = scope === "global" ? groups.length > 0 : rows.length > 0;
  // 只有挂了用量 adapter 的供应商类型可展示；不支持的类型整把 key 不渲染。
  const upstream = grants.filter((g) => isUsageSupported(g.provider_type));

  const openMain = (
    <button className="menu-bar-action" onClick={() => showMainWindow()}>
      {t("menuBar.openApp")}
    </button>
  );

  const body = () => {
    if (credentialInvalid || reauth) {
      return (
        <div className="menu-bar-state">
          <p className="error" role="alert">{t("menuBar.reauth")}</p>
          {openMain}
        </div>
      );
    }
    if (api === null) {
      return (
        <div className="menu-bar-state">
          <p className="hint">{t("menuBar.notConnected")}</p>
          {openMain}
        </div>
      );
    }
    if (identity === null) return <p className="hint">{t("menuBar.loading")}</p>;
    if (error !== null && !hasRows) {
      return <p className="error" role="alert">{t("menuBar.loadError", { message: error })}</p>;
    }
    if (!hasRows) {
      return loading ? <p className="hint">{t("menuBar.loading")}</p> : <p className="hint">{t("menuBar.noLimited")}</p>;
    }
    if (scope === "global") {
      return (
        <ol className="menu-bar-groups">
          {groups.map((group) => (
            <li key={group.userId} className="menu-bar-group">
              <h3>{t("menuBar.groupHead", { name: group.name, n: group.rows.length })}</h3>
              <RiskList rows={group.rows} />
            </li>
          ))}
        </ol>
      );
    }
    return <RiskList rows={rows} />;
  };

  return (
    <section className="menu-bar-panel" aria-label={t("menuBar.title")}>
      <header className="menu-bar-head">
        {environments.length > 1 && onSwitchEnv !== undefined ? (
          <select
            className="menu-bar-env"
            aria-label={t("settings.envAria")}
            value={activeEnvId ?? ""}
            onChange={(e) => onSwitchEnv(e.target.value)}
          >
            {environments.map((env) => (
              <option key={env.id} value={env.id}>{env.name}</option>
            ))}
          </select>
        ) : (
          <span className="menu-bar-env">{envName}</span>
        )}
        {scopes.length > 1 && (
          <div className="menu-bar-scopes" role="group" aria-label={t("menuBar.scope")}>
            {scopes.map((option) => (
              <button
                key={option}
                aria-pressed={scope === option}
                onClick={() => changeScope(option)}
              >
                {option === "self" ? t("menuBar.scopeSelf") : t("menuBar.scopeGlobal")}
              </button>
            ))}
          </div>
        )}
        <button className="menu-bar-refresh" onClick={() => { void refreshAll(); }} disabled={loading}>
          {loading ? t("menuBar.refreshing") : t("menuBar.refresh")}
        </button>
      </header>
      {error !== null && hasRows && (
        <p className="error" role="alert">{t("menuBar.loadError", { message: error })}</p>
      )}
      {error !== null && lastUpdatedAt !== null && !reauth && (
        <p className="hint">
          {t("menuBar.lastUpdated", { ago: formatFetchedAgo(lastUpdatedAt, Date.now(), translate) })}
        </p>
      )}
      {body()}
      {api !== null && upstream.length > 0 && (
        <section className="menu-bar-upstream" aria-label={t("menuBar.upstream")}>
          <h3>{t("menuBar.upstream")}</h3>
          {upstream.map((grantRow) => (
            <article className="menu-bar-upstream-row" key={grantRow.provider_key_id}>
              <header className="menu-bar-row-head">
                <strong>{grantRow.provider_name}</strong>
                <span className="hint">{t("menuBar.keyHint", { hint: grantRow.key_hint })}</span>
              </header>
              <KeyUsageCell
                api={api}
                keyRow={{ id: grantRow.provider_key_id }}
                providerType={grantRow.provider_type}
              />
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
