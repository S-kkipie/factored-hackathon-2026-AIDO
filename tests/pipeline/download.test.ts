import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ObjectStore, mirror } from "../../pipeline/download";

function fakeStore(objects: Record<string, string>): ObjectStore & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    downloads,
    async *list(prefix) {
      for (const [key, body] of Object.entries(objects)) {
        if (key.startsWith(prefix)) yield { key, size: body.length };
      }
    },
    async download(key, dest) {
      downloads.push(key);
      await Bun.write(dest, objects[key] ?? "");
    },
  };
}

describe("mirror", () => {
  test("downloads new objects, keeps the hive layout, skips identical files", async () => {
    const rawDir = await mkdtemp(join(tmpdir(), "aido-mirror-"));
    const store = fakeStore({
      "data/customers.csv": "abc",
      "data/customers.csv.bak": "zzz",
      "data/complaints/year=2026/month=06/day=10/complaints_20260610.csv": "xy",
    });

    const first = await mirror(store, ["customers.csv", "complaints"], rawDir);
    expect(first).toEqual([
      { table: "customers.csv", total: 1, downloaded: 1 },
      { table: "complaints", total: 1, downloaded: 1 },
    ]);
    expect(await readFile(join(rawDir, "customers.csv"), "utf8")).toBe("abc");
    expect(await readFile(join(rawDir, "complaints/year=2026/month=06/day=10/complaints_20260610.csv"), "utf8")).toBe("xy");

    const second = await mirror(store, ["customers.csv", "complaints"], rawDir);
    expect(second.map((r) => r.downloaded)).toEqual([0, 0]);
    expect(store.downloads).not.toContain("data/customers.csv.bak");
  });
});
