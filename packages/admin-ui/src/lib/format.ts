/** 时间显示统一口径（用户拍板）：全站 24 小时制，不随系统语言出 12 小时/AM/PM；
 * 日志时间戳固定 yyyy/mm/dd hh:mm:ss。全部手动拼装，locale 无关。 */
const p2 = (n: number) => String(n).padStart(2, "0");

/** 日志时间戳：yyyy/mm/dd hh:mm:ss（日志/我的日志行、总览最近请求）。 */
export function formatLogTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 一般时刻（时间范围端点/冷却到期/凭证时间等）：yyyy/mm/dd hh:mm。 */
export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 仅时钟（同步时刻等短距展示）：hh:mm:ss。 */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 图表日期轴（总览时间趋势）：MM/dd，子日粒度附 24 小时制 HH:mm。 */
export function formatAxisDate(ts: number, withTime: boolean): string {
  const d = new Date(ts);
  const day = `${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
  return withTime ? `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}` : day;
}
