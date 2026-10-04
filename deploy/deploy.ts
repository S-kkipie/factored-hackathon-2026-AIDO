import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";

export interface DeployOptions {
  project: string;
  region: string;
  service: string;
  repo: string;
  tag: string;
  /** Absolute path to the directory containing serving.sqlite, passed to docker as the `servingdata` build context (see docker:build in package.json and the Dockerfile). */
  dataDir: string;
  langfuse: boolean;
  /** US-region Langfuse projects need this set; the Langfuse default ingestion endpoint is the EU region. */
  langfuseBaseUrl?: string;
  modelArmor: { location: string; template: string } | null;
  capUsd: number;
  /** Dedicated runtime service account (not the Compute Engine default SA); see docs/deploy.md one-time setup. */
  serviceAccount: string;
}

/** Secret Manager names → env vars. Values live only in Secret Manager; this script never reads them. */
const SECRETS: [env: string, secret: string][] = [
  ["GEMINI_API_KEY", "aido-gemini-api-key"],
  ["JWT_SECRET", "aido-jwt-secret"],
  ["DEMO_PIN", "aido-demo-pin"],
  ["AGENT_PIN", "aido-agent-pin"],
];
const LANGFUSE_SECRETS: [string, string][] = [
  ["LANGFUSE_PUBLIC_KEY", "aido-langfuse-public-key"],
  ["LANGFUSE_SECRET_KEY", "aido-langfuse-secret-key"],
];

/** The deploy as argv arrays (spec 8: single container on Cloud Run, max-instances=1, secrets from Secret Manager). */
export function deployCommands(o: DeployOptions): string[][] {
  const image = `${o.region}-docker.pkg.dev/${o.project}/${o.repo}/${o.service}:${o.tag}`;
  const secrets = [...SECRETS, ...(o.langfuse ? LANGFUSE_SECRETS : [])].map(([env, name]) => `${env}=${name}:latest`).join(",");
  const envs = [
    `LLM_TOTAL_CAP_USD=${o.capUsd}`,
    "DEPLOY_ENV=cloud-run",
    ...(o.modelArmor ? [`MODEL_ARMOR_PROJECT=${o.project}`, `MODEL_ARMOR_LOCATION=${o.modelArmor.location}`, `MODEL_ARMOR_TEMPLATE=${o.modelArmor.template}`] : []),
    ...(o.langfuseBaseUrl ? [`LANGFUSE_BASE_URL=${o.langfuseBaseUrl}`] : []),
  ].join(",");
  return [
    // --platform linux/amd64 pins the build target (Cloud Run only runs amd64); also makes the image build
    // reproducibly from an Apple Silicon workstation.
    ["docker", "build", "--platform", "linux/amd64", "--build-context", `servingdata=${o.dataDir}`, "-t", image, "."],
    ["docker", "push", image],
    [
      "gcloud", "run", "deploy", o.service,
      "--image", image,
      "--project", o.project,
      "--region", o.region,
      "--platform", "managed",
      "--service-account", o.serviceAccount,
      "--allow-unauthenticated",
      "--max-instances", "1",
      "--min-instances", "0",
      "--memory", "1Gi",
      "--cpu", "1",
      "--timeout", "300",
      "--set-secrets", secrets,
      "--set-env-vars", envs,
    ],
  ];
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      region: { type: "string", default: "us-central1" },
      service: { type: "string", default: "aido" },
      repo: { type: "string", default: "aido" },
      tag: { type: "string" },
      "data-dir": { type: "string" },
      langfuse: { type: "boolean", default: false },
      "langfuse-base-url": { type: "string" },
      "model-armor-template": { type: "string" },
      "model-armor-location": { type: "string" },
      "cap-usd": { type: "string", default: "3" },
      "service-account": { type: "string" },
      execute: { type: "boolean", default: false },
    },
  });
  if (!values.project) throw new Error("--project is required");
  const tag = values.tag ?? Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim();
  const dataDir = realpathSync(values["data-dir"] ?? "data");
  const cmds = deployCommands({
    project: values.project,
    region: values.region!,
    service: values.service!,
    repo: values.repo!,
    tag,
    dataDir,
    langfuse: values.langfuse!,
    langfuseBaseUrl: values["langfuse-base-url"],
    modelArmor: values["model-armor-template"] ? { template: values["model-armor-template"], location: values["model-armor-location"] ?? values.region! } : null,
    capUsd: Number(values["cap-usd"]),
    serviceAccount: values["service-account"] ?? `aido-runtime@${values.project}.iam.gserviceaccount.com`,
  });
  for (const cmd of cmds) {
    console.log(`$ ${cmd.map((a) => (/[\s,=]/.test(a) ? `'${a}'` : a)).join(" ")}`);
    if (values.execute) {
      const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
      if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
    }
  }
  if (!values.execute) console.log("\n(dry run: add --execute to run these commands; see docs/deploy.md for one-time setup)");
}
