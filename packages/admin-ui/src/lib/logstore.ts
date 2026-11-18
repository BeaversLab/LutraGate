import type { LogRow } from "./api";

/**
 * 本地日志镜像的存储接口（desktop 02，prefactor）：Web = Dexie（logdb.ts），
 * 桌面 = SQLite（desktop 03）。聚合仍由纯函数完成——下推只做 ts 范围，
 * 模型/供应商等过滤留在聚合层（单一聚合来源不破）。
 */
export interface LogStore {
  /** 幂等写入（主键覆盖、批内同 id 后者胜），返回真正新增的行数。 */
  bulkPut(rows: LogRow[]): Promise<number>;
  /** 本地镜像最大 ts；空库返回 0（同步增量起点）。 */
  maxTs(): Promise<number>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  /** ts 范围查询（闭区间 [from, to]，端点含等值；半开 = 只给一侧），返回行。 */
  listLogs(from?: number, to?: number): Promise<LogRow[]>;
  /** 行数，范围语义同 listLogs。 */
  count(from?: number, to?: number): Promise<number>;
}
