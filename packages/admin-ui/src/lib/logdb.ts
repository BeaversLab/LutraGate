import Dexie, { type Table } from "dexie";
import type { LogRow } from "./api";
import type { LogStore } from "./logstore";

/**
 * 本地日志镜像的 Dexie 实现（Web；spec D4）。logs 以 id 为主键 → bulkPut 天然幂等；
 * meta 存同步游标等元数据。桌面 SQLite 实现见 desktop 03；语义由 logstore.contract 锁定。
 */

export interface MetaEntry {
  key: string;
  value: unknown;
}

export class LogDb extends Dexie implements LogStore {
  logs!: Table<LogRow, string>;
  meta!: Table<MetaEntry, string>;

  constructor(name = "lutragate") {
    super(name);
    this.version(1).stores({
      logs: "id, ts, client_model, provider_id, status",
      meta: "key",
    });
  }

  async bulkPut(rows: LogRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    // 先查已存在的 id：返回「真正新增」数；批内同 id 由 Dexie bulkPut 后者胜。
    // 注意 get→put 非原子：并发写入可能高估新增数；同步器单飞（useLogSync）无并发。
    const ids = [...new Set(rows.map((r) => r.id))];
    const existing = await this.logs.bulkGet(ids);
    await this.logs.bulkPut(rows);
    return existing.filter((r) => r === undefined).length;
  }

  async maxTs(): Promise<number> {
    const row = await this.logs.orderBy("ts").last();
    return row?.ts ?? 0;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const entry = await this.meta.get(key);
    return entry?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.meta.put({ key, value });
  }

  /** ts 索引上的闭区间范围子句；无界时返回 null（走全表路径，保持旧行为）。 */
  private tsRange(from: number | undefined, to: number | undefined) {
    if (from === undefined && to === undefined) return null;
    if (from === undefined) return this.logs.where("ts").belowOrEqual(to!);
    if (to === undefined) return this.logs.where("ts").aboveOrEqual(from);
    return this.logs.where("ts").between(from, to, true, true);
  }

  async listLogs(from?: number, to?: number): Promise<LogRow[]> {
    return this.tsRange(from, to)?.toArray() ?? this.logs.toArray();
  }

  async count(from?: number, to?: number): Promise<number> {
    return this.tsRange(from, to)?.count() ?? this.logs.count();
  }
}
