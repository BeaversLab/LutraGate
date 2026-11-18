/** 主题三态（UI 2.0 #10）：用户偏好与实际渲染主题分离 — auto 态随系统亮暗变化。 */
export type ThemePreference = "auto" | "light" | "dark";
/** 实际落到 documentElement data-theme 的值（解析后的二态）。 */
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "lutragate.theme";

function isPreference(value: string | null): value is ThemePreference {
  return value === "auto" || value === "light" || value === "dark";
}

/** 读取主题偏好：非法/缺失值一律回退 auto（默认跟随系统）。 */
export function loadThemePref(storage: Pick<Storage, "getItem">): ThemePreference {
  const raw = storage.getItem(THEME_STORAGE_KEY);
  return isPreference(raw) ? raw : "auto";
}

/** 持久化主题偏好（全局键，不随环境分槽）。 */
export function saveThemePref(storage: Pick<Storage, "setItem">, pref: ThemePreference): void {
  storage.setItem(THEME_STORAGE_KEY, pref);
}

/** 偏好 + 系统亮暗 → 实际主题：auto 透传系统值，light/dark 固定。 */
export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === "auto") return systemPrefersDark ? "dark" : "light";
  return pref;
}

/** 把解析结果落到 <html data-theme>（styles.css 的双层令牌按此切换）。 */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
}

/** 组合入口：偏好持久化 + 立即应用（控件切换时调用）。 */
export function applyThemePref(storage: Storage, pref: ThemePreference): ResolvedTheme {
  saveThemePref(storage, pref);
  const resolved = resolveTheme(pref, window.matchMedia("(prefers-color-scheme: dark)").matches);
  applyResolvedTheme(resolved);
  return resolved;
}
