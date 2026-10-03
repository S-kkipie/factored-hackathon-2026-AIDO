import { Database } from "bun:sqlite";

export interface SpendMeta {
  model: string;
  purpose: string;
  /** Who spent it: server, smoke, eval, router training… */
  source: string;
}

/**
 * Project-wide LLM spend, persisted across processes and runs (server, smoke, eval and ML scripts share one file).
 * Unlike the daily cap in ops.sqlite, this is a hard cap on total spend for the whole project.
 */
export class SpendLedger {
  private readonly db: Database;

  constructor(
    path: string,
    readonly capUsd: number,
  ) {
    if (!Number.isFinite(capUsd) || capUsd < 0) throw new Error(`invalid LLM spend cap: ${capUsd}`);
    this.db = new Database(path, { create: true });
    this.db.exec(
      "create table if not exists llm_spend (at text not null, usd real not null, model text not null, purpose text not null, source text not null)",
    );
  }

  total(): number {
    return this.db.query<{ t: number | null }, []>("select sum(usd) as t from llm_spend").get()?.t ?? 0;
  }

  /** True when spending `estimateUsd` more stays within the cap. */
  allows(estimateUsd: number): boolean {
    return this.total() + estimateUsd <= this.capUsd;
  }

  record(usd: number, meta: SpendMeta, now = new Date()): void {
    this.db
      .query("insert into llm_spend (at, usd, model, purpose, source) values (?, ?, ?, ?, ?)")
      .run(now.toISOString(), usd, meta.model, meta.purpose, meta.source);
  }
}
