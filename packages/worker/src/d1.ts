import type { AdminDb } from "@lutragate/core";
/** AdminDb port implementation over D1 (see core AdminDb). */
export class D1AdminDb implements AdminDb {
  constructor(private readonly db: D1Database) {}

  async all<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
    const { results } = await this.db.prepare(sql).bind(...params).all<T>();
    return results ?? [];
  }

  async run(sql: string, params: unknown[]): Promise<{ changes: number }> {
    const res = await this.db.prepare(sql).bind(...params).run();
    return { changes: res.meta.changes ?? 0 };
  }
}
