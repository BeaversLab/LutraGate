import type { LogRow } from "./api";
import { LOG_COLUMNS } from "./logstore.sqlite";
import { detectTauriInternals, type TauriInternals } from "./tauri";

/**
 * CSV 导出（desktop 04）：导出**原始日志行全列**（分析可事后任意重做），
 * ts 为 ISO 时间戳、null 为空串；转义遵循 RFC 4180（含逗号/引号/换行的字段
 * 加引号、内部引号翻倍）。Web 用 Blob 下载，桌面走 save_text_file 保存对话框。
 */

/** 列序与本地镜像/私库同源（LOG_COLUMNS，单一列镜像）。 */
const CSV_COLUMNS = LOG_COLUMNS;

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(raw)) return `"${raw.replaceAll('"', '""')}"`;
  return raw;
}

/** 全列原始行 → CSV 文本（首行表头，\n 行尾）。 */
export function logsToCsv(rows: LogRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      CSV_COLUMNS.map((col) => {
        // ts 统一 ISO 时间戳（导出口径，spec desktop 04）。
        if (col === "ts") return csvField(new Date(row.ts));
        return csvField(row[col]);
      }).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export interface CsvIo {
  /** Web 下载缝（测试注入；缺省用 URL.createObjectURL）。 */
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  /** 桌面探测缝（测试注入；缺省运行时探测）。 */
  tauri?: TauriInternals | null;
}

/**
 * 导出当前命中的行：Web → Blob 下载（返回 "web"）；桌面 → 保存对话框
 * （save_text_file；返回 "saved" 或 "cancelled"，取消非错误）。
 */
export async function exportCsv(defaultName: string, rows: LogRow[], io: CsvIo = {}): Promise<"web" | "saved" | "cancelled"> {
  const contents = logsToCsv(rows);
  const internals = io.tauri !== undefined ? io.tauri : detectTauriInternals();
  if (internals !== null) {
    const saved = (await internals.invoke("save_text_file", { defaultName, contents })) as string | null;
    return saved === null ? "cancelled" : "saved";
  }

  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const createObjectURL = io.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeObjectURL = io.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u));
  const url = createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = defaultName;
  anchor.click();
  // 延迟回收：同步 revoke 会让 Safari 等浏览器中止下载。
  setTimeout(() => revokeObjectURL(url), 0);
  return "web";
}
