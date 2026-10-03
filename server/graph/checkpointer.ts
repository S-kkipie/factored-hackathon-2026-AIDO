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
import type { Param, Sql } from "../db/sql";

/**
 * LangGraph checkpoint saver on our `Sql` seam (Supabase Postgres or PGlite), tables `ops.checkpoints` and
 * `ops.writes` (created by the Supabase migration). Same layout as the official savers, with the subset of behavior
 * our graph uses (no pending-send migration from checkpoint format < 4, which this project never wrote). The
 * official PostgresSaver needs `pg` and its own schema management; this one shares the server's connection.
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

const CHECKPOINT_COLUMNS = "thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata";

/** postgres.js returns bytea as Buffer; the serializer wants a plain Uint8Array view. */
const bytes = (v: Uint8Array | string): Uint8Array | string =>
  typeof v === "string" ? v : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

export class SqlCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly db: Sql) {
    super();
  }

  private async toTuple(row: CheckpointRow): Promise<CheckpointTuple> {
    const writes = await this.db.all<WriteRow>(
      "select task_id, channel, type, value from ops.writes where thread_id = $1 and checkpoint_ns = $2 and checkpoint_id = $3 order by task_id, idx",
      [row.thread_id, row.checkpoint_ns, row.checkpoint_id],
    );
    const type = row.type ?? "json";
    return {
      config: {
        configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id },
      },
      checkpoint: (await this.serde.loadsTyped(type, bytes(row.checkpoint))) as Checkpoint,
      metadata: (await this.serde.loadsTyped(type, bytes(row.metadata))) as CheckpointMetadata,
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
            [w.task_id, w.channel, await this.serde.loadsTyped(w.type ?? "json", w.value === null ? "" : bytes(w.value))] as [
              string,
              string,
              unknown,
            ],
        ),
      ),
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    if (typeof thread_id !== "string") return undefined;
    const row = checkpoint_id
      ? await this.db.one<CheckpointRow>(
          `select ${CHECKPOINT_COLUMNS} from ops.checkpoints where thread_id = $1 and checkpoint_ns = $2 and checkpoint_id = $3`,
          [thread_id, checkpoint_ns, String(checkpoint_id)],
        )
      : await this.db.one<CheckpointRow>(
          `select ${CHECKPOINT_COLUMNS} from ops.checkpoints where thread_id = $1 and checkpoint_ns = $2 order by checkpoint_id desc limit 1`,
          [thread_id, checkpoint_ns],
        );
    return row ? this.toTuple(row) : undefined;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const where: string[] = [];
    const args: Param[] = [];
    const add = (clause: string, value: string) => {
      args.push(value);
      where.push(`${clause} $${args.length}`);
    };
    const { thread_id, checkpoint_ns } = config.configurable ?? {};
    if (typeof thread_id === "string") add("thread_id =", thread_id);
    if (typeof checkpoint_ns === "string") add("checkpoint_ns =", checkpoint_ns);
    const before = options?.before?.configurable?.checkpoint_id;
    if (before !== undefined) add("checkpoint_id <", String(before));
    const sql = `select ${CHECKPOINT_COLUMNS} from ops.checkpoints ${where.length ? `where ${where.join(" and ")}` : ""} order by checkpoint_id desc`;
    let yielded = 0;
    const limit = options?.limit ? Math.max(1, Math.trunc(options.limit)) : undefined;
    for (const row of await this.db.all<CheckpointRow>(sql, args)) {
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
    await this.db.run(
      `insert into ops.checkpoints (${CHECKPOINT_COLUMNS}) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (thread_id, checkpoint_ns, checkpoint_id) do update set
         parent_checkpoint_id = excluded.parent_checkpoint_id, type = excluded.type,
         checkpoint = excluded.checkpoint, metadata = excluded.metadata`,
      [thread_id, checkpoint_ns, checkpoint.id, parent === undefined ? null : String(parent), type, cp, meta],
    );
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
        return { args: [thread_id, checkpoint_ns, String(checkpoint_id), taskId, writeIdx, channel, type, data] as Param[], special: writeIdx < 0 };
      }),
    );
    const insert =
      "insert into ops.writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) values ($1, $2, $3, $4, $5, $6, $7, $8)";
    const key = "(thread_id, checkpoint_ns, checkpoint_id, task_id, idx)";
    // Special channels (errors, interrupts) are replaced; regular writes keep the first value (upsert-or-ignore).
    await this.db.tx(async (tx) => {
      for (const r of rows) {
        await tx.run(
          r.special
            ? `${insert} on conflict ${key} do update set channel = excluded.channel, type = excluded.type, value = excluded.value`
            : `${insert} on conflict ${key} do nothing`,
          r.args,
        );
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.db.tx(async (tx) => {
      await tx.run("delete from ops.checkpoints where thread_id = $1", [threadId]);
      await tx.run("delete from ops.writes where thread_id = $1", [threadId]);
    });
  }
}
