import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { S3Client } from "bun";
import { defaultConfig } from "./config";

export interface RemoteObject {
  key: string;
  size: number;
}

export interface ObjectStore {
  list(prefix: string): AsyncIterable<RemoteObject>;
  download(key: string, dest: string): Promise<void>;
}

export interface MirrorResult {
  table: string;
  total: number;
  downloaded: number;
}

/** Tables consumed by the pipeline. Names ending in .csv are single files; others are partitioned folders. */
export const DEFAULT_TABLES = [
  "customers.csv",
  "products.csv",
  "transactions",
  "complaints",
  "call_center_interactions",
] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name} (see .env.example)`);
  return value;
}

export function bunS3Store(): ObjectStore {
  const client = new S3Client({
    bucket: required("S3_BUCKET"),
    region: process.env.S3_REGION ?? "us-east-2",
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  });
  return {
    async *list(prefix) {
      let token: string | undefined;
      do {
        const page = await client.list({ prefix, continuationToken: token });
        for (const o of page.contents ?? []) yield { key: o.key, size: o.size ?? 0 };
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token);
    },
    async download(key, dest) {
      await mkdir(dirname(dest), { recursive: true });
      await Bun.write(dest, client.file(key));
    },
  };
}

const destFor = (rawDir: string, key: string) => join(rawDir, key.replace(/^data\//, ""));
const localSize = (path: string) => (existsSync(path) ? statSync(path).size : -1);

export async function mirror(
  store: ObjectStore,
  tables: readonly string[],
  rawDir: string,
  concurrency = 16,
): Promise<MirrorResult[]> {
  const results: MirrorResult[] = [];
  for (const table of tables) {
    const isFile = table.endsWith(".csv");
    const prefix = isFile ? `data/${table}` : `data/${table}/`;
    const objects: RemoteObject[] = [];
    for await (const o of store.list(prefix)) {
      if (!isFile || o.key === prefix) objects.push(o);
    }
    const todo = objects.filter((o) => localSize(destFor(rawDir, o.key)) !== o.size);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const o = todo[next++];
        if (o) await store.download(o.key, destFor(rawDir, o.key));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    results.push({ table, total: objects.length, downloaded: todo.length });
  }
  return results;
}

if (import.meta.main) {
  const tables = process.argv.length > 2 ? process.argv.slice(2) : [...DEFAULT_TABLES];
  const results = await mirror(bunS3Store(), tables, defaultConfig().rawDir);
  for (const r of results) console.log(`${r.table}: ${r.downloaded} downloaded / ${r.total} remote`);
}
