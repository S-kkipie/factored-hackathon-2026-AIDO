import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { RuleId } from "../rules";

export type SchemaResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; ruleId: Extract<RuleId, "SC_INVALID">; errors: string[]; attempts: number };

function parse(raw: unknown): { data?: unknown; error?: string } {
  if (typeof raw !== "string") return { data: raw };
  const fenced = raw.match(/`{3}(?:json)?\s*([\s\S]*?)`{3}/);
  try {
    return { data: JSON.parse((fenced?.[1] ?? raw).trim()) };
  } catch {
    return { error: "output is not valid JSON" };
  }
}

/** Gate 3: model output becomes data only if it validates; otherwise retry once, then fail closed. */
export async function withSchema<S extends TSchema>(
  schema: S,
  produce: (attempt: number, previousErrors: string[]) => Promise<unknown>,
  maxAttempts = 2,
): Promise<SchemaResult<Static<S>>> {
  let errors: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data, error } = parse(await produce(attempt, errors));
    if (error) {
      errors = [error];
      continue;
    }
    if (Value.Check(schema, data)) return { ok: true, value: data as Static<S>, attempts: attempt };
    errors = [...Value.Errors(schema, data)].map((e) => `${e.path || "/"} ${e.message}`);
  }
  return { ok: false, ruleId: "SC_INVALID", errors, attempts: maxAttempts };
}
