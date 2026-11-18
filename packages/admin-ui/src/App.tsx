import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminApi, ApiError, type Identity } from "./lib/api";
import { toErrorMessage } from "./lib/error";
import {
  activeEnvOf,
  deleteEnvTokenEverywhere,
  emptyEnvState,
  loadEnvState,
  loadEnvToken,
  loadEnvTokenSecure,
  newEnvId,
  normalizeBaseUrl,
  removeEnv,
  saveEnvState,
  saveEnvToken,
  saveEnvTokenSecure,
  setActiveEnv,
  upsertEnv,
  type EnvRecord,
  type EnvStoreState,
} from "./lib/envs";
import { detectSecretStore } from "./lib/secrets";
import { SettingsBar, type SettingsDraft } from "./components/SettingsBar";
import { ProvidersPanel } from "./components/ProvidersPanel";
import { KeysPanel } from "./components/KeysPanel";
import { MappingsPanel } from "./components/MappingsPanel";
import { RawLogPanel } from "./components/RawLogPanel";
import { useConfirm } from "./components/ConfirmModal";
import { UsersPanel } from "./components/UsersPanel";
import { MyKeysPanel } from "./components/MyKeysPanel";
import { MyModelsPanel } from "./components/MyModelsPanel";
import type { LogStore } from "./lib/logstore";
import { deleteLogStoreData, detectLogStore } from "./lib/logstore.detect";
import { ThemeLocaleControls } from "./components/ThemeLocaleControls";
import { EnvSelect } from "./components/EnvSelect";
import logoUrl from "./assets/logo.png";
import { SyncFooter } from "./components/SyncFooter";
import { useToast } from "./components/Toast";
import { UsageAnalysis, type UsageAnalysisContext } from "./components/UsageAnalysis";
import { InstrumentOverview } from "./components/InstrumentOverview";
import {
  ChartNoAxesCombined,
  ArrowLeftRight,
  Boxes,
  KeyRound,
  LayoutDashboard,
  ScrollText,
  Server,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import "./i18n";

type AdminTab = "usage-analysis" | "overview" | "logs" | "providers" | "keys" | "mappings" | "users";
type UserTab = "my-overview" | "my-usage-analysis" | "my-logs" | "my-keys" | "my-models";
type Tab = AdminTab | UserTab;
/** 壳层页 = 面板页之外的环境设置页（UI 2.0 #11）。 */
type Page = Tab | "settings";
/** 视角（UI 2.0 #11）：仅导航分组切换，不授予权限（面板门控仍看 identity）。 */
type Perspective = "admin" | "personal";

/** 管理首页合并原仪表盘与流量图；用量分析承载深入比较。 */
const ADMIN_TABS: AdminTab[] = ["overview", "usage-analysis", "logs", "providers", "keys", "mappings", "users"];

/** user 视图 = 仅自己的面板（multi-user 07），无任何全局配置入口。 */
const USER_TABS: UserTab[] = ["my-overview", "my-usage-analysis", "my-logs", "my-keys", "my-models"];

/** 视角 → 导航分组 / 回落首页（UI 2.0 #11）：切换视角落对应首页。 */
const NAV_TABS: Record<Perspective, Tab[]> = { admin: ADMIN_TABS, personal: USER_TABS };
const FALLBACK_PAGE: Record<Perspective, Page> = { admin: "overview", personal: "my-overview" };

/** 导航图标（#20 验收：demo 同构的 ico 位，lucide；文字保留，图标是辅助线索）。 */
const TAB_ICONS: Record<Page, LucideIcon> = {
  overview: LayoutDashboard,
  "usage-analysis": ChartNoAxesCombined,
  logs: ScrollText,
  providers: Server,
  keys: KeyRound,
  mappings: ArrowLeftRight,
  users: Users,
  "my-overview": LayoutDashboard,
  "my-usage-analysis": ChartNoAxesCombined,
  "my-logs": ScrollText,
  "my-keys": KeyRound,
  "my-models": Boxes,
  settings: Settings,
};

export function App() {
  const { t } = useTranslation();
  // 多环境模型（multi-env 01）：具名环境列表 + 活跃环境；tracer bullet 阶段 UI 只呈现单环境。
  const [envState, setEnvState] = useState<EnvStoreState>(emptyEnvState);
  // 活跃环境的 lgm_（引导期也可暂存 ADMIN_TOKEN）：Web=localStorage 明文分槽；桌面=Keychain 分槽。
  const [activeToken, setActiveToken] = useState("");
  // 登录身份（multi-user 06）：活跃环境变更时取 /admin/me，按角色渲染视图。
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [credentialInvalid, setCredentialInvalid] = useState(false);
  const [meError, setMeError] = useState<string | null>(null);
  // 运行时探测 Tauri：桌面 = lgm_ 走 SecretStore（Keychain）；Web = null，行为零变化（desktop 01）。
  const secretStore = useMemo(() => detectSecretStore(), []);
  const [secretDegraded, setSecretDegraded] = useState(false);
  const activeEnv = activeEnvOf(envState);
  const activeEnvId = activeEnv?.id ?? null;
  // 当前活跃 env id 的同步镜像：异步 token 加载的竞态守卫（multi-env 04）——
  // 加载期间环境被切换/删除时，旧环境的 lgm_ 不得复活打到新网关（spec 故事 12）。
  const activeEnvIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeEnvIdRef.current = activeEnvId;
  }, [activeEnvId]);

  /** 把指定环境的 lgm_ 装入活跃 token 状态：Web = localStorage 同步取；桌面 = Keychain
   * 异步取（安全存储不可用 → 降级明文 + degraded 警告）。启动/切换/删除回落共用。 */
  const activateEnvToken = useCallback(
    (envId: string) => {
      if (secretStore === null) {
        setActiveToken(loadEnvToken(window.localStorage, envId));
        return;
      }
      void loadEnvTokenSecure(secretStore, window.localStorage, envId).then((loaded) => {
        // 竞态守卫：异步加载期间活跃环境已切换或被删除 → 丢弃本次结果。
        if (activeEnvIdRef.current !== envId) return;
        setActiveToken(loaded.token);
        setSecretDegraded(loaded.degraded);
      });
    },
    [secretStore],
  );

  // 启动：环境列表同步读 localStorage；活跃环境的 lgm_ 按形态取（桌面异步 Keychain 分槽）。
  useEffect(() => {
    const state = loadEnvState(window.localStorage);
    setEnvState(state);
    const env = activeEnvOf(state);
    if (env === null) return;
    activateEnvToken(env.id);
  }, [activateEnvToken]);

  // 本地日志镜像按 env id 分库（multi-env 01/03）：桌面 = SQLite 私库
  // lutragate-<id>.db（永久保留），Web = Dexie lutragate-<id>。
  // 同步生命周期绑定活跃环境（spec 同步语义）：库带 env id 入状态，渲染时守卫
  // 「env id 匹配才可见」——切换窗口内（新库异步打开期间）旧库不可达，杜绝
  // 「新网关 api + 旧环境库」的串库写入；切走环境的数据冻结在其自己的库里。
  const [dbEntry, setDbEntry] = useState<{ envId: string; store: LogStore } | null>(null);
  useEffect(() => {
    if (activeEnvId === null) {
      setDbEntry(null);
      return;
    }
    let cancelled = false;
    void detectLogStore(activeEnvId).then((store) => {
      if (!cancelled) setDbEntry({ envId: activeEnvId, store });
    });
    return () => {
      cancelled = true;
    };
  }, [activeEnvId]);
  const db = dbEntry !== null && dbEntry.envId === activeEnvId ? dbEntry.store : null;

  /** lgm_ 按环境分槽持久化 + 更新活跃 token：Web = 明文 localStorage（Web 惯例）；
   * 桌面 = Keychain 分槽，失败 → 明文降级 + 常驻警告。 */
  const persistEnvToken = useCallback(
    (envId: string, token: string) => {
      if (secretStore === null) {
        saveEnvToken(window.localStorage, envId, token);
        setActiveToken(token);
        return;
      }
      void saveEnvTokenSecure(secretStore, window.localStorage, envId, token).then((result) => {
        setSecretDegraded(result.degraded);
        setActiveToken(token);
      });
    },
    [secretStore],
  );

  /** 环境名规范化：空白名回退「默认」（首启/新建的上手路径与现状等长，multi-env 01）。 */
  const envName = (raw: string): string => raw.trim() || t("settings.defaultEnvName");

  const onSaveSettings = useCallback(
    (draft: SettingsDraft) => {
      if (activeEnv === null) return;
      // 编辑活跃环境：改名/改地址（id 不变，数据与凭证不丢）。
      const nextEnv: EnvRecord = {
        ...activeEnv,
        name: envName(draft.name),
        gatewayUrl: normalizeBaseUrl(draft.gatewayUrl),
      };
      const next = upsertEnv(envState, nextEnv);
      saveEnvState(window.localStorage, next);
      setEnvState(next);
      persistEnvToken(nextEnv.id, draft.managementToken);
      showToast(t("toast.envSaved"));
    },
    [activeEnv, envState, persistEnvToken],
  );

  /** 新建环境并切换过去（spec 故事 2）：登记即活跃，原环境凭证保留不动。 */
  const onCreateEnv = useCallback(
    (draft: SettingsDraft) => {
      const env: EnvRecord = {
        id: newEnvId(),
        name: envName(draft.name),
        gatewayUrl: normalizeBaseUrl(draft.gatewayUrl),
      };
      const next = setActiveEnv(upsertEnv(envState, env), env.id);
      saveEnvState(window.localStorage, next);
      setEnvState(next);
      persistEnvToken(env.id, draft.managementToken);
      showToast(t("toast.envCreated", { name: env.name }));
    },
    [envState, persistEnvToken],
  );

  /** 一键切换：活跃标记 + 目标环境的 lgm_ 分槽（Web=localStorage；桌面=Keychain 异步）。
   * 不删除任何数据；身份由活跃环境变更自然重取（api memo）。 */
  const onSwitchEnv = useCallback(
    (envId: string) => {
      const next = setActiveEnv(envState, envId);
      if (next === envState) return;
      saveEnvState(window.localStorage, next);
      setEnvState(next);
      // 先清空活跃 token：configured 转 false，避免「新地址 + 旧环境 token」打向目标
      // 网关（故事 12：身份不得串环境）；桌面 Keychain 异步加载由 activateEnvToken 竞态守卫。
      setActiveToken("");
      activateEnvToken(envId);
    },
    [envState, activateEnvToken],
  );

  const { confirmAction, dialog: confirmDialog } = useConfirm();
  const { showToast, toast } = useToast();

  /** 删除环境（multi-env 04，spec 故事 7/8）：显式破坏性操作——二次确认文案明示
   * 本地日志史不可恢复；执行 = 设置项移除（活跃回落剩余环境）+ 凭证分槽双清
   * + 该环境本地库数据清除。切换环境永不走这里。
   * 确认走页内弹窗（useConfirm）：window.confirm 在桌面 WKWebView 静默返回 false。 */
  const onDeleteEnv = useCallback(
    async (envId: string) => {
      const target = envState.environments.find((e) => e.id === envId);
      if (target === undefined) return;
      const message = t("app.deleteEnvConfirm", { name: target.name });
      if (!(await confirmAction(message))) return;
      const next = removeEnv(envState, envId);
      saveEnvState(window.localStorage, next);
      setEnvState(next);
      const wasActive = envId === activeEnvId;
      if (wasActive) {
        // 删的是活跃环境：旧库先失去可见性（dbEntry 守卫）、凭证清空，再按剩余环境回落。
        setDbEntry(null);
        setActiveToken("");
        const fallback = activeEnvOf(next);
        if (fallback !== null) activateEnvToken(fallback.id);
      }
      // 删除已生效（环境出列表、活跃回落完成）后再播报；凭证/本地库清除不阻塞 UI。
      showToast(t("toast.envDeleted", { name: target.name }));
      // 凭证分槽双清（Keychain + 明文降级副本）与本地库数据清除，均不阻塞 UI。
      void deleteEnvTokenEverywhere(secretStore, window.localStorage, envId);
      void deleteLogStoreData(envId).catch((e) => { console.error("DELETE_LOG_STORE_FAILED", e);
        /* 清库失败（如桌面 IPC 异常）：环境与凭证已删，残留数据文件成为已知孤儿
           （开发阶段不弹常驻警告；无自动重试入口）。 */
      });
    },
    [envState, activeEnvId, secretStore, activateEnvToken, confirmAction],
  );

  // UI 上下文随环境整体重置（spec「App 汇聚点改造」）由 <ShellBody key={envId}>
  // 的重挂载承载（与旧 <main key> 同一手法）：页面/视角回默认，不做环境级状态记忆，
  // 也不会出现「重置 effect 晚于用户导航触发、把页面打回默认」的竞态。

  const configured = activeEnv !== null && activeEnv.gatewayUrl.length > 0 && activeToken.length > 0;
  const gatewayUrl = activeEnv?.gatewayUrl ?? "";
  // Memoized: a fresh instance per render would re-trigger every panel's effect.
  // 活跃环境变更（地址/token）→ 重建 AdminApi 并重取身份（spec「App 汇聚点改造」）。
  const api = useMemo(
    () => (configured ? new AdminApi({ baseUrl: gatewayUrl, adminToken: activeToken }) : null),
    [configured, gatewayUrl, activeToken],
  );

  useEffect(() => {
    if (api === null) return;
    setCredentialInvalid(false);
    setMeError(null);
    setIdentity(null);
    api
      .getMe()
      .then(setIdentity)
      .catch((err: unknown) => {
        // 401 = 凭证无效（spec）；其他失败（网络/5xx）给出可重试的错误提示。
        if (err instanceof ApiError && err.status === 401) setCredentialInvalid(true);
        else setMeError(toErrorMessage(err));
      });
  }, [api]);


  return (
    <div className="app-shell">
      {/* titlebar：品牌块（logo+名+副题，reference 形态）左置，右侧全局控件
          （主题/语言）；Web 下即页面头部，桌面原生窗口控件区由系统保留。 */}
      <header className="titlebar">
        <div className="brand">
          <img className="brand-logo" src={logoUrl} alt="" aria-hidden="true" />
          <div>
            <strong>{t("shell.title")}</strong>
            <small>{t("shell.subtitle")}</small>
          </div>
        </div>
        {/* 全局控件（UI 2.0 #10）：主题三态 + 语言切换；全局记忆，不随环境分槽。 */}
        <ThemeLocaleControls />
      </header>

      {/* key：切换环境 = 壳层 UI 上下文（页面/视角）整体重置（spec）。 */}
      <ShellBody
        key={activeEnvId ?? "none"}
        identity={identity}
        configured={configured}
        credentialInvalid={credentialInvalid}
        meError={meError}
        api={api}
        db={db}
        gatewayUrl={gatewayUrl}
        environments={envState.environments}
        activeEnvId={activeEnvId}
        onSwitchEnv={onSwitchEnv}
        settingsBar={
          // key：异步 Keychain 加载完成后重挂载，输入框回填活跃环境已加载的设置（桌面路径）。
          <SettingsBar
            key={`${activeEnvId ?? "bootstrap"}|${activeToken.length}`}
            environments={envState.environments}
            activeEnvId={activeEnvId}
            initial={{
              name: activeEnv?.name ?? "",
              gatewayUrl,
              managementToken: activeToken,
            }}
            onSave={onSaveSettings}
            onCreate={onCreateEnv}
            onSwitch={onSwitchEnv}
            onDelete={onDeleteEnv}
            secretDegraded={secretDegraded}
            api={api}
          />
        }
      />

      {/* 页内二次确认弹窗（桌面联验修复）：删除环境等破坏性操作的确认载体。 */}
      {confirmDialog}
      {/* 全局 toast（UI 2.0 #11）：环境保存/新建/删除等操作反馈。 */}
      {toast}
    </div>
  );
}

/**
 * 壳层主体（UI 2.0 #11）：固定侧栏（品牌/环境下拉/视角切换/导航/环境设置入口）
 * + main（环境设置页或既有面板 + 页脚同步条）。页面与视角状态归本组件私有，
 * 由外层 key={envId} 重挂载整体重置。视角切换仅改变导航分组，不授予权限
 * （面板渲染门控仍由 identity 决定，对应旧 showSelfTabs 语义）。
 */
function ShellBody({
  identity,
  configured,
  credentialInvalid,
  meError,
  api,
  db,
  gatewayUrl,
  environments,
  activeEnvId,
  onSwitchEnv,
  settingsBar,
}: {
  identity: Identity | null;
  configured: boolean;
  credentialInvalid: boolean;
  meError: string | null;
  api: AdminApi | null;
  db: LogStore | null;
  gatewayUrl: string;
  environments: Array<{ id: string; name: string }>;
  activeEnvId: string | null;
  onSwitchEnv: (envId: string) => void;
  settingsBar: React.ReactNode;
}) {
  const { t } = useTranslation();
  const pageFromHash = (): Page => window.location.hash === "#/my-usage-analysis" ? "my-usage-analysis" : window.location.hash === "#/my-overview" ? "my-overview" : window.location.hash === "#/usage-analysis" ? "usage-analysis" : "overview";
  const [activePage, updateActivePage] = useState<Page>(pageFromHash);
  const [analysisContext, setAnalysisContext] = useState<UsageAnalysisContext | undefined>();
  const [personalAnalysisContext, setPersonalAnalysisContext] = useState<UsageAnalysisContext | undefined>();
  const setActivePage = (page: Page) => {
    updateActivePage(page);
    if (["overview", "usage-analysis", "my-overview", "my-usage-analysis"].includes(page)) window.location.hash = `/${page}`;
    else if (["#/overview", "#/usage-analysis", "#/my-overview", "#/my-usage-analysis"].includes(window.location.hash)) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  };
  useEffect(() => {
    const onHash = () => { updateActivePage(pageFromHash()); if (window.location.hash.startsWith("#/my-")) setPerspectivePref("personal"); else if (["#/overview", "#/usage-analysis"].includes(window.location.hash)) setPerspectivePref("admin"); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [perspectivePref, setPerspectivePref] = useState<Perspective>(() => window.location.hash.startsWith("#/my-") ? "personal" : "admin");

  const isAdmin = identity?.role === "administrator";
  // administrator（有真实 user id）同样是用户：自助面板照常可用，范围限定
  // 在自己的 user 上；虚拟管理员（引导/CF Access，无 user id）没有「自己」，
  // 只保留全局面板。
  const showSelfTabs = identity !== null && (identity.role === "user" || identity.id !== null);
  // 视角（UI 2.0 #11）：能看管理导航 = administrator；能看个人导航 = showSelfTabs；
  // 两者都能看（administrator 且有真实 user id）才出现切换按钮。
  const canShowAdminNav = identity !== null && isAdmin;
  const perspective: Perspective = canShowAdminNav
    ? (showSelfTabs ? perspectivePref : "admin")
    : "personal";
  const canTogglePerspective = canShowAdminNav && showSelfTabs;
  const navTabs = NAV_TABS[perspective];
  // 页面合法性：当前页不属于当前视角导航（视角切换/身份变化后）→ 回该视角首页。
  const pageIsValid = activePage === "settings" || navTabs.includes(activePage as Tab);
  const activePageOrFallback: Page = pageIsValid ? activePage : FALLBACK_PAGE[perspective];

  return (
    <div className="shell-body">
      <aside className="sidebar">
        {/* 环境下拉一键切换（UI 2.0 #11）：语义与设置页 chips 相同——切活跃
            标记 + 分槽凭证加载，切换不删除任何数据。 */}
        {environments.length > 0 && (
          <EnvSelect
            environments={environments}
            activeEnvId={activeEnvId}
            onSwitch={onSwitchEnv}
            ariaLabel={t("shell.envLabel")}
          />
        )}
        {canTogglePerspective && (
          <div className="perspective" role="group" aria-label={t("shell.perspectiveLabel")}>
            <button
              type="button"
              aria-pressed={perspective === "admin"}
              className={perspective === "admin" ? "active" : ""}
              onClick={() => {
                setPerspectivePref("admin");
                setActivePage("overview");
              }}
            >
              {t("shell.perspectiveAdmin")}
            </button>
            <button
              type="button"
              aria-pressed={perspective === "personal"}
              className={perspective === "personal" ? "active" : ""}
              onClick={() => {
                // 切到个人视角落「我的总览」（spec 故事 12）。
                setPerspectivePref("personal");
                setActivePage("my-overview");
              }}
            >
              {t("shell.perspectivePersonal")}
            </button>
          </div>
        )}
        {identity !== null && (
          <nav className="sidenav" aria-label={t("shell.navLabel")}>
            {navTabs.map((tabId) => {
              const Icon = TAB_ICONS[tabId];
              return (
                <button
                  key={tabId}
                  type="button"
                  className={activePageOrFallback === tabId ? "active" : ""}
                  onClick={() => setActivePage(tabId)}
                >
                  <Icon className="nav-ico" size={16} aria-hidden="true" />
                  {t(`tabs.${tabId}`)}
                </button>
              );
            })}
          </nav>
        )}
        <button
          type="button"
          className={`sidenav-button sidenav-settings ${activePageOrFallback === "settings" ? "active" : ""}`}
          onClick={() => setActivePage("settings")}
        >
          <Settings className="nav-ico" size={16} aria-hidden="true" />
          {t("shell.settingsEntry")}
        </button>
      </aside>

      <main className="main">
        <div className="main-content">
        {!configured ? (
          <section className="panel-card">
            <h2>{t("settings.pageTitle")}</h2>
            <p className="hint">{t("app.hintConfigure")}</p>
            {settingsBar}
          </section>
        ) : credentialInvalid ? (
          <section className="panel-card">
            <h2>{t("settings.pageTitle")}</h2>
            <p className="error" role="alert">{t("app.credentialInvalid")}</p>
            {settingsBar}
          </section>
        ) : meError !== null ? (
          <p className="error" role="alert">{t("app.meError", { message: meError })}</p>
        ) : identity === null ? (
          <p className="hint">{t("app.verifying")}</p>
        ) : activePageOrFallback === "settings" ? (
          <section className="panel-card">
            <h2>{t("settings.pageTitle")}</h2>
            {settingsBar}
          </section>
        ) : (
          <>
            {api && db && (activePageOrFallback === "overview" || activePageOrFallback === "usage-analysis") && <div hidden={activePageOrFallback !== "overview"}><InstrumentOverview key={activeEnvId} api={api} db={db} onViewLogs={() => setActivePage("logs")} onAnalyze={context => { setAnalysisContext(context); setActivePage("usage-analysis"); }} /></div>}
            {api && db && activePageOrFallback === "usage-analysis" && <UsageAnalysis api={api} db={db} context={analysisContext} onBack={() => setActivePage("overview")} />}
            {api && db && activePageOrFallback === "logs" && <RawLogPanel api={api} db={db} />}
            {api && activePageOrFallback === "providers" && <ProvidersPanel api={api} />}
            {api && activePageOrFallback === "keys" && <KeysPanel api={api} />}
            {api && activePageOrFallback === "mappings" && <MappingsPanel api={api} />}
            {api && activePageOrFallback === "users" && <UsersPanel api={api} />}
            {api && db && identity.id !== null && (activePageOrFallback === "my-overview" || activePageOrFallback === "my-usage-analysis") && <div hidden={activePageOrFallback !== "my-overview"}><InstrumentOverview key={`personal-${activeEnvId}-${identity.id}`} api={api} db={db} identity={identity} onViewLogs={() => setActivePage("my-logs")} onAnalyze={context => { setPersonalAnalysisContext(context); setActivePage("my-usage-analysis"); }} /></div>}
            {api && db && identity.id !== null && activePageOrFallback === "my-usage-analysis" && <UsageAnalysis api={api} db={db} identity={identity} context={personalAnalysisContext} onBack={() => setActivePage("my-overview")} />}
            {api && db && activePageOrFallback === "my-logs" && <RawLogPanel api={api} db={db} identity={identity} selfOnly />}
            {api && activePageOrFallback === "my-keys" && <MyKeysPanel api={api} identity={identity} />}
            {api && activePageOrFallback === "my-models" && <MyModelsPanel api={api} baseUrl={gatewayUrl} />}
          </>
        )}
        </div>
        {/* 页脚本地同步状态条（UI 2.0 #11）：随壳层按 env 重挂载，读各库 meta。 */}
        <SyncFooter db={db} />
      </main>
    </div>
  );
}
