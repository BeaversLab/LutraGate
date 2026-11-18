/** 桌面内嵌功能版本注入缝（open-core #36）：闭源桌面壳的 license bootstrap 挂全局
 * （与 __lutragateLicense 同族、同一脚本注入），设置页「桌面功能」版本行的数据源。
 * Web 不注入 → null → 该行不渲染。
 */

export const DESKTOP_VERSION_GLOBAL = "__lutragateDesktopVersion";

/** 运行时探测注入的桌面功能版本；形状不符（防误注）一律视为未注入。 */
export function detectDesktopVersion(
  read: (name: string) => unknown = (name) => (globalThis as Record<string, unknown>)[name],
): string | null {
  const value = read(DESKTOP_VERSION_GLOBAL);
  return typeof value === "string" && value !== "" ? value : null;
}
