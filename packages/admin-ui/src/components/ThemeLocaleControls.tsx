import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Monitor, Sun, Moon, type LucideIcon } from "lucide-react";
import {
  applyThemePref,
  loadThemePref,
  resolveTheme,
  applyResolvedTheme,
  type ThemePreference,
} from "../lib/theme";
import { detectLocale, saveLocalePref, type AppLocale } from "../i18n";

/**
 * 头部全局控件（UI 2.0 #10；#20 验收起图标化）：主题三态分段按钮
 * （auto/light/dark，lucide 图标 + hover title 提示，全局 localStorage
 * `lutragate.theme` 记忆，默认 auto）+ 语言切换（中/EN，`lutragate.locale`，
 * 默认跟浏览器）。auto 态监听 prefers-color-scheme 变化实时跟随。
 * 语言按钮文案用语言自称（中/EN）而非翻译——切错语言也能找到回家的路。
 */
const THEME_OPTIONS: Array<{ value: ThemePreference; icon: LucideIcon; labelKey: string }> = [
  { value: "auto", icon: Monitor, labelKey: "theme.auto" },
  { value: "light", icon: Sun, labelKey: "theme.light" },
  { value: "dark", icon: Moon, labelKey: "theme.dark" },
];

/** 语言自称（不经 i18n，任何语言态下的按钮文字一致）。 */
const LOCALE_SELF_NAME: Record<AppLocale, string> = { zh: "中", en: "EN" };

export function ThemeLocaleControls() {
  const { t, i18n } = useTranslation();
  const [themePref, setThemePref] = useState<ThemePreference>(() => loadThemePref(window.localStorage));
  // 语言初值走同一检测口径（存储偏好 → 浏览器语言），与 i18n init 一致。
  const [locale, setLocale] = useState<AppLocale>(() => detectLocale(window.navigator, window.localStorage));

  // 偏好变化即持久化并应用；auto 态挂系统亮暗监听，切走时卸载。
  useEffect(() => {
    applyThemePref(window.localStorage, themePref);
    if (themePref !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyResolvedTheme(resolveTheme("auto", mq.matches));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [themePref]);

  const changeLocale = (next: AppLocale) => {
    setLocale(next);
    saveLocalePref(window.localStorage, next);
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    void i18n.changeLanguage(next);
  };

  return (
    <div className="header-controls">
      <div className="seg" role="group" aria-label={t("theme.label")}>
        {THEME_OPTIONS.map(({ value, icon: Icon, labelKey }) => (
          <button
            key={value}
            type="button"
            data-testid={`theme-${value}`}
            className={themePref === value ? "active" : ""}
            aria-pressed={themePref === value}
            aria-label={t(labelKey)}
            title={t(labelKey)}
            onClick={() => setThemePref(value)}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="seg" role="group" aria-label={t("language.label")}>
        {(["zh", "en"] as const).map((loc) => (
          <button
            key={loc}
            type="button"
            data-testid={`locale-${loc}`}
            className={locale === loc ? "active" : ""}
            aria-pressed={locale === loc}
            title={loc === "zh" ? "中文" : "English"}
            onClick={() => changeLocale(loc)}
          >
            {LOCALE_SELF_NAME[loc]}
          </button>
        ))}
      </div>
    </div>
  );
}
