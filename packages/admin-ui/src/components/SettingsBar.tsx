import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { EnvSelect } from "./EnvSelect";
import type { AdminApi, ServerRelease } from "../lib/api";
import { detectDesktopVersion } from "../lib/desktop-version";
import { defaultGatewayUrl } from "../lib/envs";

/** 连接设置草稿（multi-env 01）：新建/编辑环境共用的三字段。 */
export interface SettingsDraft {
  name: string;
  gatewayUrl: string;
  managementToken: string;
}

/** 环境列表条目（multi-env 02）：chips 渲染所需的最小面。 */
export interface EnvChip {
  id: string;
  name: string;
}

/**
 * 环境管理（multi-env 02/04，spec「UI 入口」）：环境 chips（常驻显示活跃环境名，视觉锚点）
 * + 活跃环境编辑表单（改名/改地址，id 与数据不变）+ 新建第二个环境（创建即切换）
 * + 删除活跃环境（破坏性操作，App 侧二次确认）。lgm_ 存储：Web = localStorage
 * 分槽；桌面 = Keychain 分槽（槽名 management-token:<envId>）。
 */
export function SettingsBar({
  environments,
  fixedGatewayUrl,
  activeEnvId,
  initial,
  onSave,
  onCreate,
  onSwitch,
  onDelete,
  secretDegraded = false,
  api = null,
}: {
  /** 全部已登记环境（chips 顺序即列表序）。 */
  environments: EnvChip[];
  /** 内置 Web 仅管理当前网关的凭证。 */
  fixedGatewayUrl?: string;
  /** 活跃环境 id；null = 零环境（首启引导 = 新建模式）。 */
  activeEnvId: string | null;
  /** 活跃环境的当前值（编辑表单回填）；零环境时忽略。 */
  initial: SettingsDraft;
  /** 保存对活跃环境的改名/改地址/token（id 不变）。 */
  onSave: (s: SettingsDraft) => void;
  /** 新建环境并切换过去。 */
  onCreate: (s: SettingsDraft) => void;
  /** 一键切换（不删除任何数据）。 */
  onSwitch: (envId: string) => void;
  /** 删除环境（multi-env 04）：App 侧先二次确认，再清设置/凭证/本地库。 */
  onDelete: (envId: string) => void;
  /** true = OS 安全存储不可用，token 明文降级 → 常驻警告（不可关闭）。 */
  secretDegraded?: boolean;
  /** 活跃环境的 AdminApi：提供时拉取 /version 显示服务器版本信息（首启引导无 api 不显示）。 */
  api?: AdminApi | null;
}) {
  const { t } = useTranslation();
  // 零环境 = 首启引导，直接进入新建模式（multi-env 01 的上手路径）。
  const multiEnv = fixedGatewayUrl === undefined;
  const [creating, setCreating] = useState(multiEnv && activeEnvId === null);
  // 服务器发布信息（/version）：拉取失败/旧服务器 404 → 保持 null 不显示，不打扰设置页。
  const [release, setRelease] = useState<ServerRelease | null>(null);
  useEffect(() => {
    if (api === null) return;
    let cancelled = false;
    api
      .getVersion()
      .then((info) => {
        if (!cancelled) setRelease(info);
      })
      .catch(() => {
        /* 旧服务器无 /version 或网络失败：静默不显示。 */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);
  // 版本行文案：标签 · 短 hash（标签缺失时退化为短 hash）。
  const serverVersionText =
    release === null
      ? ""
      : [release.tag, release.commit?.slice(0, 7)].filter(Boolean).join(" · ") || t("settings.versionUnknown");
  // 桌面内嵌功能版本（open-core #36）：闭源壳在 bundle 前注入全局、值不可变；Web = null 不渲染。
  const desktopVersion = detectDesktopVersion();
  // 空白名回退「默认」：编辑表单回填与取消复位共用同一口径（App 侧 envName 同规则）。
  const defaultName = t("settings.defaultEnvName");
  const initialName = initial.name === "" ? defaultName : initial.name;
  const [name, setName] = useState(creating ? defaultName : initialName);
  // 同源预填（builtin-web 03）：新建模式默认当前 origin（内置 Web 端少填一次）；
  // 桌面/自定义协议形态回退空串，行为与旧版一致。
  const [gatewayUrl, setGatewayUrl] = useState(creating ? defaultGatewayUrl() : initial.gatewayUrl);
  const [managementToken, setManagementToken] = useState(creating ? "" : initial.managementToken);

  const startCreate = () => {
    setCreating(true);
    setName(defaultName);
    setGatewayUrl(defaultGatewayUrl());
    setManagementToken("");
  };

  return (
    <form
      className="settings"
      onSubmit={(e) => {
        e.preventDefault();
        const draft: SettingsDraft = { name, gatewayUrl: fixedGatewayUrl ?? gatewayUrl, managementToken };
        // 创建后 App 重挂载本组件（活跃环境变更），本地无需复位。
        if (creating) onCreate(draft);
        else onSave(draft);
      }}
    >
      {secretDegraded && (
        <p className="error" role="alert">
          {t("settings.secretDegraded")}
        </p>
      )}
      {multiEnv && environments.length > 0 && (
        <div className="env-chips">
          {/* 与侧栏同一环境切换下拉（UI 2.0 统一入口）；aria 名用「切换环境」
              避免与侧栏下拉同屏重名（测试/读屏均按名字定位）。 */}
          <EnvSelect
            environments={environments}
            activeEnvId={activeEnvId}
            onSwitch={onSwitch}
            ariaLabel={t("settings.envAria")}
          />
          <button type="button" className="env-chip env-chip-new" onClick={startCreate}>
            {t("settings.newEnv")}
          </button>
        </div>
      )}
      {creating ? <p className="hint">{t("settings.createHint")}</p> : null}
      {multiEnv && (
        <label>
          {t("settings.name")}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("settings.namePlaceholder")} />
        </label>
      )}
      <label>
        {t("settings.url")}
        <input
          value={fixedGatewayUrl ?? gatewayUrl}
          readOnly={!multiEnv}
          onChange={(e) => setGatewayUrl(e.target.value)}
          placeholder="http://localhost:8787"
        />
      </label>
      <label>
        {t("settings.token")}
        <input
          type="password"
          value={managementToken}
          onChange={(e) => setManagementToken(e.target.value)}
          placeholder="lgm_"
        />
      </label>
      {creating ? (
        <>
          <button type="submit">{t("settings.create")}</button>
          {activeEnvId !== null && (
            <button
              type="button"
              onClick={() => {
                // 取消新建：回到活跃环境编辑表单（回填已保存值）。
                setCreating(false);
                setName(initialName);
                setGatewayUrl(initial.gatewayUrl);
                setManagementToken(initial.managementToken);
              }}
            >
              {t("settings.cancel")}
            </button>
          )}
        </>
      ) : (
        <>
          <button type="submit">{t("settings.save")}</button>
          {multiEnv && activeEnvId !== null && (
            <button type="button" className="env-delete" onClick={() => onDelete(activeEnvId)}>
              {t("settings.deleteEnv")}
            </button>
          )}
        </>
      )}
      {release && (
        // 与表单/按钮同一行（.settings flex 流内），不放 delete 下面另起一行。
        <span className="server-release">
          {t("settings.serverVersion", { version: serverVersionText })}
        </span>
      )}
      {/* 关于信息（open-core #36）：内嵌 Web 前端版本常显（桌面嵌入的是构建期快照，
          可能滞后于网关；Web 亦为真实版本）；桌面功能版本仅桌面形态注入时出现。 */}
      <span className="server-release">{t("settings.frontendVersion", { version: __APP_VERSION__ })}</span>
      {desktopVersion !== null && (
        <span className="server-release">{t("settings.desktopVersion", { version: desktopVersion })}</span>
      )}
    </form>
  );
}
