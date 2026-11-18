import { Server, ChevronDown } from "lucide-react";

/** 环境切换下拉（UI 2.0 统一入口）：侧栏与环境设置页共用同一控件与观感——
 * 切换语义（活跃标记 + 分槽凭证加载）由 App 的 onSwitchEnv 承载，此处纯展示；
 * ariaLabel 由调用方传入（侧栏「环境」，设置页「切换环境」避免同屏重名）。 */
export function EnvSelect({
  environments,
  activeEnvId,
  onSwitch,
  ariaLabel,
}: {
  /** 全部已登记环境（option 顺序即列表序）。 */
  environments: Array<{ id: string; name: string }>;
  /** 活跃环境 id；null = 零环境（调用方负责隐藏控件）。 */
  activeEnvId: string | null;
  /** 一键切换（不删除任何数据）。 */
  onSwitch: (envId: string) => void;
  /** 控件的可访问名。 */
  ariaLabel: string;
}) {
  return (
    <div className="env-control">
      <Server size={16} className="env-icon" aria-hidden="true" />
      <select
        className="env-select"
        aria-label={ariaLabel}
        value={activeEnvId ?? ""}
        onChange={(e) => onSwitch(e.target.value)}
      >
        {environments.map((env) => (
          <option key={env.id} value={env.id}>{env.name}</option>
        ))}
      </select>
      <ChevronDown size={14} className="env-chevron" aria-hidden="true" />
    </div>
  );
}
