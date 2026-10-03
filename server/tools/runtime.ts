import { ProvenanceError } from "../provenance";
import type { RuleIdWithPrefix } from "../rules";

export class ToolError extends Error {
  constructor(
    readonly ruleId: RuleIdWithPrefix<"TL">,
    readonly tool: string,
    message: string,
    readonly retryable = false,
  ) {
    super(`${ruleId} (${tool}): ${message}`);
  }
}

export interface RunOptions {
  timeoutMs: number;
  retries: number;
  backoffMs: number;
}

const DEFAULTS: RunOptions = { timeoutMs: 3000, retries: 2, backoffMs: 100 };

class Timeout extends Error {}

const isRetryable = (e: unknown) =>
  !(e instanceof ProvenanceError) && !(e instanceof ToolError && !e.retryable);

/** Runs a tool with a timeout and bounded exponential-backoff retries. */
export async function runTool<T>(
  tool: string,
  fn: () => Promise<T> | T,
  options: Partial<RunOptions> = {},
): Promise<{ value: T; attempts: number }> {
  const o = { ...DEFAULTS, ...options };
  let last: unknown;
  for (let attempt = 1; attempt <= o.retries + 1; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout(`timed out after ${o.timeoutMs} ms`)), o.timeoutMs);
      });
      const value = await Promise.race([Promise.resolve().then(fn), timeout]);
      return { value, attempts: attempt };
    } catch (e) {
      last = e;
      if (!isRetryable(e)) throw e;
      if (attempt <= o.retries) await Bun.sleep(o.backoffMs * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ToolError("TL_FAIL", tool, last instanceof Error ? last.message : String(last));
}
