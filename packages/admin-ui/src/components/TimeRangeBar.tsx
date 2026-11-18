import { useTranslation } from "react-i18next";
import type { TimeRange } from "../lib/aggregate";

/**
 * 时间窗控件（desktop 04；UI 2.0 #18 迁 i18n）：快捷档 + 自定义档（from/to
 * 日期）。状态由父面板持有（与既有筛选同风格）；日期 → epoch 窗口的换算见
 * aggregate.customWindow。键放顶层 timeRange.*——仪表盘两页复用同一控件。
 */

const QUICK: Array<{ id: TimeRange; key: string }> = [
  { id: "24h", key: "h24" },
  { id: "7d", key: "d7" },
  { id: "30d", key: "d30" },
  { id: "all", key: "all" },
];

export function TimeRangeBar({
  range,
  customFrom,
  customTo,
  onRangeChange,
  onCustomChange,
}: {
  range: TimeRange;
  customFrom: string;
  customTo: string;
  onRangeChange: (range: TimeRange) => void;
  onCustomChange: (from: string, to: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {QUICK.map((r) => (
        <button
          key={r.id}
          className={range === r.id ? "tab active" : "tab"}
          onClick={() => onRangeChange(r.id)}
        >
          {t(`timeRange.${r.key}`)}
        </button>
      ))}
      <button
        className={range === "custom" ? "tab active" : "tab"}
        onClick={() => onRangeChange("custom")}
      >
        {t("timeRange.custom")}
      </button>
      {range === "custom" && (
        <>
          <input
            type="date"
            aria-label={t("timeRange.from")}
            value={customFrom}
            max={customTo || undefined}
            onChange={(e) => onCustomChange(e.target.value, customTo)}
          />
          <span>{t("timeRange.toSep")}</span>
          <input
            type="date"
            aria-label={t("timeRange.to")}
            value={customTo}
            min={customFrom || undefined}
            onChange={(e) => onCustomChange(customFrom, e.target.value)}
          />
        </>
      )}
    </>
  );
}
