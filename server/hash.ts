export const sha256Hex = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** JSON with recursively sorted object keys, so equal values always serialize (and hash) identically. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value)) ?? "null";
}
