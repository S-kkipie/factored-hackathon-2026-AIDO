import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PipelineConfig, defaultConfig } from "../../pipeline/config";
import { CONTRACTS } from "../../pipeline/contracts";
import type { Duck } from "../../pipeline/duck";
import { type StageResult, listSourceFiles, stageTable } from "../../pipeline/stage";

export const TX_HEADER =
  "transaction_id,transaction_date,process_date,product_id,customer_id,transaction_type,transaction_category,amount,currency,amount_usd,channel,merchant_name,merchant_category,transaction_country,transaction_city,transaction_status,response_code,is_fraud,fraud_score";

/** Copy the fixtures into a fresh temp directory and return a config pointing at it. */
export async function makeWorkspace(): Promise<PipelineConfig> {
  const dir = await mkdtemp(join(tmpdir(), "aido-pipeline-"));
  await cp(join(import.meta.dir, "fixtures/raw"), join(dir, "raw"), { recursive: true });
  return defaultConfig({
    rawDir: join(dir, "raw"),
    warehousePath: join(dir, "warehouse.duckdb"),
    servingPath: join(dir, "serving.sqlite"),
    martsDir: join(dir, "marts"),
    reportsDir: join(dir, "reports"),
    runsDir: join(dir, "runs"),
  });
}

export async function stageAll(duck: Duck, config: PipelineConfig, loadId: string): Promise<StageResult[]> {
  const results: StageResult[] = [];
  for (const contract of CONTRACTS) {
    const files = await listSourceFiles(config.rawDir, contract.files);
    results.push(await stageTable(duck, contract, files, config.rawDir, loadId));
  }
  return results;
}
