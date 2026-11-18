import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./i18n";
import { applyResolvedTheme, loadThemePref, resolveTheme } from "./lib/theme";
import "./styles.css";

// 主题在首帧前落 <html data-theme>（UI 2.0 #10）：存储偏好 → 解析 → 应用，
// 避免暗色偏好用户看到浅色闪屏。只应用不回写——「默认 auto」与「用户选了 auto」
// 语义有别；后续切换与持久化由 ThemeLocaleControls 接管。
applyResolvedTheme(
  resolveTheme(loadThemePref(window.localStorage), window.matchMedia("(prefers-color-scheme: dark)").matches),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
