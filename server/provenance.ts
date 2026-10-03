/** Where a value came from. Only `jwt` and `db` values may identify a customer or a record to act on. */
export type Source = "jwt" | "db" | "user" | "llm";

export interface Val<T> {
  readonly v: T;
  readonly src: Source;
}

export const val = <T>(v: T, src: Source): Val<T> => ({ v, src });

export class ProvenanceError extends Error {
  readonly ruleId = "PROV_001";
  constructor(
    readonly field: string,
    readonly src: Source,
  ) {
    super(`PROV_001: ${field} has untrusted source '${src}'`);
  }
}

export function trusted<T>(field: string, value: Val<T>, allowed: readonly Source[] = ["jwt", "db"]): T {
  if (!allowed.includes(value.src)) throw new ProvenanceError(field, value.src);
  return value.v;
}
