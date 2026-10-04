import type { Database } from "bun:sqlite";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  WRITES_IDX_MAP,
  copyCheckpoint,
} from "@langchain/langgraph-checkpoint";

/**
 * LangGraph checkpoint saver on `bun:sqlite`, stored in ops.sqlite. The official SqliteSaver needs better-sqlite3,
 * which Bun cannot load; this is the same table layout with the subset of behavior our graph uses (no pending-send
 * migration from checkpoint format < 4, which this project never wrote).
 */
interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: Uint8Array | string;
  metadata: Uint8Array | string;
}

interface WriteRow {
  task_id: string;
  channel: string;
  type: string | null;
  value: Uint8Array | string | null;
}

const SCHEMA = `
  create table if not exists checkpoints (
    thread_id text not null, checkpoint_ns text not null default '', checkpoint_id text not null,
    parent_checkpoint_id text, type text, checkpoint blob, metadata blob,
    primary key (thread_id, checkpoint_ns, checkpoint_id));
  create table if not exists writes (
    thread_id text not null, checkpoint_ns text not null default '', checkpoint_id text not null,
    task_id text not null, idx integer not null, channel text not null, type text, value blob,
    primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));
`;

export class BunSqliteSaver extends BaseCheckpointSaver {
  constructor(private readonly db: Database) {
    super();
    db.exec(SCHEMA);
  }

  private async toTuple(row: CheckpointRow): Promise<CheckpointTuple> {
    const writes = this.db
      .query<WriteRow, [string, string, string]>(
        "select task_id, channel, type, value from writes where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ? order by task_id, idx",
      )
      .all(row.thread_id, row.checkpoint_ns, row.checkpoint_id);
    const type = row.type ?? "json";
    return {
      config: {
        configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id },
      },
      checkpoint: (await this.serde.loadsTyped(type, row.checkpoint)) as Checkpoint,
      metadata: (await this.serde.loadsTyped(type, row.metadata)) as CheckpointMetadata,
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites: await Promise.all(
        writes.map(
          async (w) =>
            [w.task_id, w.channel, await this.serde.loadsTyped(w.type ?? "json", w.value ?? "")] as [string, string, unknown],
        ),
      ),
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    if (typeof thread_id !== "string") return undefined;
    const row = checkpoint_id
      ? this.db
          .query<CheckpointRow, [string, string, string]>(
            "select * from checkpoints where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?",
          )
          .get(thread_id, checkpoint_ns, String(checkpoint_id))
      : this.db
          .query<CheckpointRow, [string, string]>(
            // Latest = last written (rowid), not the greatest id: LangGraph's uuid6 ids embed wall-clock time, and a
            // clock step back (seen under WSL during an LLM call) made a newer checkpoint sort before an older one.
            "select * from checkpoints where thread_id = ? and checkpoint_ns = ? order by rowid desc limit 1",
          )
          .get(thread_id, checkpoint_ns);
    return row ? this.toTuple(row) : undefined;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const where: string[] = [];
    const args: string[] = [];
    const { thread_id, checkpoint_ns } = config.configurable ?? {};
    if (typeof thread_id === "string") {
      where.push("thread_id = ?");
      args.push(thread_id);
    }
    if (typeof checkpoint_ns === "string") {
      where.push("checkpoint_ns = ?");
      args.push(checkpoint_ns);
    }
    const before = options?.before?.configurable?.checkpoint_id;
    if (before !== undefined) {
      where.push("rowid < coalesce((select b.rowid from checkpoints b where b.checkpoint_id = ? and b.thread_id = checkpoints.thread_id and b.checkpoint_ns = checkpoints.checkpoint_ns), -1)");
      args.push(String(before));
    }
    // Newest first by write order (see getTuple).
    const sql = `select * from checkpoints ${where.length ? `where ${where.join(" and ")}` : ""} order by rowid desc`;
    let yielded = 0;
    const limit = options?.limit ? Math.max(1, Math.trunc(options.limit)) : undefined;
    for (const row of this.db.query<CheckpointRow, string[]>(sql).all(...args)) {
      const tuple = await this.toTuple(row);
      const filter = options?.filter ?? {};
      const meta = tuple.metadata as Record<string, unknown> | undefined;
      if (Object.entries(filter).every(([k, v]) => v === undefined || meta?.[k] === v)) {
        yield tuple;
        yielded++;
        if (limit !== undefined && yielded >= limit) break;
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const thread_id = config.configurable?.thread_id;
    if (typeof thread_id !== "string") throw new Error('Missing "thread_id" in config.configurable');
    const checkpoint_ns = String(config.configurable?.checkpoint_ns ?? "");
    const parent = config.configurable?.checkpoint_id;
    const [[type, cp], [metaType, meta]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type !== metaType) throw new Error("checkpoint and metadata serialized to different types");
    this.db
      .query(
        "insert or replace into checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(thread_id, checkpoint_ns, checkpoint.id, parent === undefined ? null : String(parent), type, cp, meta);
    return { configurable: { thread_id, checkpoint_ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const thread_id = config.configurable?.thread_id;
    const checkpoint_id = config.configurable?.checkpoint_id;
    if (typeof thread_id !== "string" || checkpoint_id === undefined) {
      throw new Error("putWrites needs thread_id and checkpoint_id");
    }
    const checkpoint_ns = String(config.configurable?.checkpoint_ns ?? "");
    const rows = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [type, data] = await this.serde.dumpsTyped(value);
        const writeIdx = WRITES_IDX_MAP[channel] ?? idx;
        return [thread_id, checkpoint_ns, String(checkpoint_id), taskId, writeIdx, channel, type, data, writeIdx < 0] as const;
      }),
    );
    const stmtReplace = this.db.query(
      `insert or replace into writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const stmtIgnore = this.db.query(
      `insert or ignore into writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const r of rows) {
        const [threadId, ns, cpId, task, idx, channel, type, value, isSpecial] = r;
        const stmt = isSpecial ? stmtReplace : stmtIgnore;
        stmt.run(threadId, ns, cpId, task, idx, channel, type, value);
      }
    })();
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.query("delete from checkpoints where thread_id = ?").run(threadId);
      this.db.query("delete from writes where thread_id = ?").run(threadId);
    })();
  }
}
