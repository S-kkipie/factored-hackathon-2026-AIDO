import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type PipelineConfig, defaultConfig } from "./config";
import { CONTRACTS } from "./contracts";
import { type Persona, curate } from "./curate";
import { openDuck } from "./duck";
import { fingerprint, gitSha, sha256File, writeManifest } from "./manifest";
import { buildMarts, renderDemandMarkdown } from "./marts";
import { type TableQuality, assessTable, renderQualityMarkdown } from "./quality";
import { type StageResult, ensureStagingSchema, listSourceFiles, stageTable } from "./stage";

export interface RunSummary {
  runId: string;
  stages: StageResult[];
  quality: TableQuality[];
  personas: Record<Persona, string>;
  manifestPath: string;
}

export async function runPipeline(config: PipelineConfig): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[-:]/g, "").replace(/\..*$/, "")}-${crypto.randomUUID().slice(0, 8)}`;
  await mkdir(dirname(config.warehousePath), { recursive: true });
  await mkdir(config.reportsDir, { recursive: true });

  const duck = await openDuck(config.warehousePath);
  try {
    await ensureStagingSchema(duck);
    const stages: StageResult[] = [];
    const inputs: Record<string, { files: number; fingerprint: string }> = {};
    for (const contract of CONTRACTS) {
      const files = await listSourceFiles(config.rawDir, contract.files);
      inputs[contract.table] = { files: files.length, fingerprint: fingerprint(files, config.rawDir) };
      stages.push(await stageTable(duck, contract, files, config.rawDir, runId));
    }

    const curated = await curate(duck, config);
    const marts = await buildMarts(duck, config.martsDir);
    const quality: TableQuality[] = [];
    for (const contract of CONTRACTS) quality.push(await assessTable(duck, contract));

    await Bun.write(join(config.reportsDir, "quality.md"), renderQualityMarkdown(quality, stages, runId));
    await Bun.write(join(config.reportsDir, "demand.md"), renderDemandMarkdown(marts));

    const manifestPath = await writeManifest(config.runsDir, {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      gitSha: gitSha(),
      parameters: {
        clock: config.clock,
        windowDays: config.windowDays,
        recentDays: config.recentDays,
        subsetSize: config.subsetSize,
        seed: config.seed,
        maxAutoUsd: config.maxAutoUsd,
        fraudScore: config.fraudScore,
      },
      inputs,
      stages,
      outputs: {
        serving: {
          path: config.servingPath,
          sha256: await sha256File(config.servingPath),
          customers: curated.customers,
          transactions: curated.transactions,
        },
      },
    });
    return { runId, stages, quality, personas: curated.personas, manifestPath };
  } finally {
    duck.close();
  }
}

if (import.meta.main) {
  const summary = await runPipeline(defaultConfig());
  console.table(summary.stages);
  console.log("personas:", summary.personas);
  console.log("manifest:", summary.manifestPath);
}
