import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WEB_SRC = join(import.meta.dir, "../../web/src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

test("the web app never renders raw HTML or evaluates strings", () => {
  const offenders = files(WEB_SRC).filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\(|new Function\(/.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});
