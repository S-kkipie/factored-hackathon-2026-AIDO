import { describe, expect, test } from "bun:test";
import { loadServerConfig } from "../../server/config";
import { sha256Hex } from "../../server/hash";
import { ProvenanceError, trusted, val } from "../../server/provenance";

describe("trusted", () => {
  test("returns the value when the source is allowed", () => {
    expect(trusted("customerId", val("CLI-A", "jwt"))).toBe("CLI-A");
    expect(trusted("tx", val("TRX-1", "db"))).toBe("TRX-1");
  });
  test("throws PROV_001 for model- or user-sourced identity values", () => {
    expect(() => trusted("customerId", val("CLI-B", "llm"))).toThrow(ProvenanceError);
    try {
      trusted("customerId", val("CLI-B", "user"), ["jwt"]);
    } catch (e) {
      expect(e).toBeInstanceOf(ProvenanceError);
      expect((e as ProvenanceError).ruleId).toBe("PROV_001");
      expect((e as ProvenanceError).field).toBe("customerId");
    }
  });
  test("can restrict to a single source", () => {
    expect(() => trusted("customerId", val("CLI-A", "db"), ["jwt"])).toThrow("PROV_001");
  });
});

describe("loadServerConfig", () => {
  test("requires a 32+ character JWT secret", () => {
    expect(() => loadServerConfig({ JWT_SECRET: "short" })).toThrow("JWT_SECRET");
    const cfg = loadServerConfig({ JWT_SECRET: "x".repeat(32), SAFE_MODE: "1" });
    expect(cfg.safeMode).toBe(true);
    expect(cfg.sessionTtlSeconds).toBe(900);
  });
});

describe("sha256Hex", () => {
  test("hashes deterministically", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
