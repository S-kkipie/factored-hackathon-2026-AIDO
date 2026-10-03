import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { ROOT } from "./config";
import type { StageResult, SourceFile } from "./stage";

export interface Manifest {
  runId: string;
  startedAt: string;
  finishedAt: string;
  gitSha: string | null;
  parameters: Record<string, string | number>;
  inputs: Record<string, { files: number; fingerprint: string }>;
  stages: StageResult[];
  outputs: { serving: { path: string; sha256: string; customers: number; transactions: number } };
}

/** Stable fingerprint of an input set: sha256 over sorted "relative-path:size" lines. */
export function fingerprint(files: readonly SourceFile[], rawDir: string): string {
  const lines = files
    .map((f) => `${relative(rawDir, f.path)}:${f.size}`)
    .sort()
    .join("\n");
  return new Bun.CryptoHasher("sha256").update(lines).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
}

export function gitSha(): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

export async function writeManifest(runsDir: string, manifest: Manifest): Promise<string> {
  const dir = join(runsDir, manifest.runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}
