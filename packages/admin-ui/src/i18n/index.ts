import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en";
import { zh } from "./zh";

/** 支持的语言（UI 2.0 #10）：本期仅 zh/en。 */
export type AppLocale = "zh" | "en";
export const LOCALE_STORAGE_KEY = "lutragate.locale";

/** navigator.language → 初始语言：zh-* → zh，其余 → en（spec 拍板）。 */
export function localeFromBrowserLanguage(language: string | undefined): AppLocale {
  return (language ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** 读取语言偏好：非法/缺失值回退浏览器语言（zh-* → zh 否则 en）。 */
export function detectLocale(
  navigatorLike: { language?: string },
  storage: Pick<Storage, "getItem">,
): AppLocale {
  const stored = storage.getItem(LOCALE_STORAGE_KEY);
  if (stored === "zh" || stored === "en") return stored;
  return localeFromBrowserLanguage(navigatorLike.language);
}

/** 持久化语言偏好（全局键，不随环境分槽）。 */
export function saveLocalePref(storage: Pick<Storage, "setItem">, locale: AppLocale): void {
  storage.setItem(LOCALE_STORAGE_KEY, locale);
}

// 默认实例 + initReactI18next：组件无需 I18nextProvider 直接 useTranslation()。
// 检测发生在模块加载（main.tsx / 测试 setup 之前），setup 里再 changeLanguage 固定 zh。
void i18next.use(initReactI18next).init({
  lng: detectLocale(window.navigator, window.localStorage),
  fallbackLng: "zh",
  resources: { zh: { translation: zh }, en: { translation: en } },
  interpolation: { escapeValue: false }, // React 已转义
  react: { useSuspense: false },
});

export { i18next as i18n };
