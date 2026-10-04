import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../pipeline/config";
import { canonicalJson, sha256Hex } from "../server/hash";
import { SCENARIO_LANGS, type Scenario } from "./scenario";
import { type Pick, SELECTORS } from "./select";
import { FAMILIES } from "./templates";

export const scenarioHash = (scenarios: Scenario[]): string => sha256Hex(canonicalJson(scenarios));

/**
 * Builds one split. Each family's candidate pool is ordered by sha256(seed + key). Every fifth candidate is
 * reserved for dev, the rest for test, so dev and test use different customers wherever a pool is large enough.
 * Test takes `perLanguage` picks per language (ES first, then PT, without overlap); dev takes one per language.
 * Small pools wrap around, and the report notes that.
 */
export function buildScenarios(
  db: Database,
  o: { split: "dev" | "test"; seed: string; families?: string[]; allowShort?: boolean },
): Scenario[] {
  const out: Scenario[] = [];
  const families = o.families ? FAMILIES.filter((f) => o.families!.includes(f.id)) : FAMILIES;
  const pools = new Map<string, Pick[]>();
  for (const family of families) {
    let all = pools.get(family.selector);
    if (!all) {
      all = SELECTORS[family.selector](db).sort((a, b) =>
        sha256Hex(`${o.seed}:${family.selector}:${a.key}`).localeCompare(sha256Hex(`${o.seed}:${family.selector}:${b.key}`)),
      );
      pools.set(family.selector, all);
    }
    // Different families on the same selector start at different offsets so they do not reuse the same customers.
    const offset = Number.parseInt(sha256Hex(`${o.seed}:${family.id}`).slice(0, 6), 16);
    const pool = all.filter((_, i) => (o.split === "dev") === (i % 5 === 0));
    const usable = pool.length > 0 ? pool : all;
    if (usable.length === 0) {
      if (o.allowShort) continue;
      throw new Error(`no candidates for family '${family.id}' (selector ${family.selector})`);
    }
    const perLang = o.split === "dev" ? 1 : family.perLanguage;
    SCENARIO_LANGS.forEach((lang, li) => {
      for (let i = 0; i < perLang; i++) {
        const pick = usable[(offset + li * perLang + i) % usable.length]!;
        const built = family.build({ lang, pick, index: i });
        out.push({
          id: `${o.split}-${family.id}-${lang}-${i}`,
          family: family.id,
          split: o.split,
          category: family.category,
          language: lang,
          customerId: pick.customerId,
          turns: built.turns,
          fault: built.fault ?? null,
          foreign: built.foreign ?? { amounts: [], merchants: [] },
          gold: built.gold,
        });
      }
    });
  }
  return out;
}

if (import.meta.main) {
  const db = new Database(join(ROOT, "data/serving.sqlite"), { readonly: true });
  const dir = join(ROOT, "data/eval");
  mkdirSync(dir, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const split of ["dev", "test"] as const) {
    const scenarios = buildScenarios(db, { split, seed: `aido-eval-${split}-1` });
    writeFileSync(join(dir, `${split}.json`), JSON.stringify(scenarios, null, 1));
    hashes[split] = scenarioHash(scenarios);
    console.log(`${split}: ${scenarios.length} scenarios, sha256 ${hashes[split]}`);
  }
  writeFileSync(join(ROOT, "eval/frozen.json"), `${JSON.stringify({ ...hashes, seed: "aido-eval-*-1" }, null, 2)}\n`);
}
