import { describe, expect, it } from "vitest";
import type { LogRow } from "./api";
import { exportCsv, logsToCsv } from "./csv";

/** CSV 导出（desktop 04）：全列、ISO 时间戳、RFC 4180 转义、Web/桌面双路径。 */

let seq = 0;
function log(partial: Partial<LogRow>): LogRow {
  return {
    id: `csv-${seq++}`,
    request_id: "r",
    ts: 1_700_000_000_000,
    client_model: "m1",
    upstream_model: null,
    provider_id: "p1",
    key_id: null,
    prompt_tokens: 10,
    completion_tokens: 5,
    latency_ms: 50,
    status: 200,
    error_type: null,
    user_id: null,
    access_key_id: null,
    ...partial,
  };
}

describe("logsToCsv", () => {
  it("全列表头 + 行值；ts 为 ISO 时间戳、null 为空串", () => {
    const csv = logsToCsv([
      log({ id: "a", ts: 1_700_000_000_000, client_model: "gpt-4", upstream_model: null }),
    ]);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("id,request_id,ts,client_model,upstream_model,provider_id,key_id,prompt_tokens,cached_tokens,completion_tokens,latency_ms,status,error_type,error_message,user_id,access_key_id");
    expect(lines[1]).toBe("a,r,2023-11-14T22:13:20.000Z,gpt-4,,p1,,10,,5,50,200,,,,");
  });

  it("转义：逗号/引号/换行的字段加引号，内部引号翻倍", () => {
    const csv = logsToCsv([log({ id: "x", client_model: 'mo"del, v2\nnext' })]);
    // 字段被引号包裹（含换行），内部引号翻倍——只断言表头成行 + 字段形态。
    expect(csv.split("\n")[0]).toBe("id,request_id,ts,client_model,upstream_model,provider_id,key_id,prompt_tokens,cached_tokens,completion_tokens,latency_ms,status,error_type,error_message,user_id,access_key_id");
    expect(csv).toContain('"mo""del, v2\nnext"');
  });
});

describe("exportCsv", () => {
  it("Web 路径：Blob 下载（注入 createObjectURL 捕获内容）", async () => {
    const blobs: Blob[] = [];
    const urls: string[] = [];
    const result = await exportCsv(
      "lutragate-logs.csv",
      [log({ id: "a" })],
      {
        tauri: null,
        createObjectURL: (b) => {
          blobs.push(b);
          return `blob:${blobs.length}`;
        },
        revokeObjectURL: (u) => urls.push(u),
      },
    );
    expect(result).toBe("web");
    await new Promise((r) => setTimeout(r, 5)); // 回收延迟一拍（Safari 兼容）
    expect(urls).toEqual(["blob:1"]);
    // jsdom Blob 无 text()——以类型与大小断言（全文内容由桌面路径 invoke 断言覆盖）。
    expect(blobs[0]!.type).toBe("text/csv;charset=utf-8");
    expect(blobs[0]!.size).toBeGreaterThan(0);
  });

  it("桌面路径：invoke save_text_file 传文件名与全文，返回 saved；取消返回 cancelled", async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    let reply: string | null = "/Users/x/导出.csv";
    const tauri = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        return reply;
      },
    };
    const saved = await exportCsv("a.csv", [log({ id: "b" })], { tauri });
    expect(saved).toBe("saved");
    expect(calls[0]!.cmd).toBe("save_text_file");
    expect(calls[0]!.args.defaultName).toBe("a.csv");
    expect(String(calls[0]!.args.contents).startsWith("id,request_id")).toBe(true);

    reply = null; // 用户取消
    expect(await exportCsv("a.csv", [], { tauri })).toBe("cancelled");
  });
});
