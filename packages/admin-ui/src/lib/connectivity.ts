/**
 * 连通性测试的展示辅助（03 起测试本体走服务端转发：POST
 * /admin/providers/:id/test）。客户端直连实现已删除——它依赖上游允许
 * CORS（智谱回显任意 origin 可通，火山方舟无 CORS 头 → 桌面 WebView
 * 直接 Load failed，见 .scratch/provider-usage/issues/03）。
 */

/** 纯函数：人类可读的延迟描述。 */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
