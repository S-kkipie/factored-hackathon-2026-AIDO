import { expect, test } from "bun:test";
import { deployCommands } from "../../deploy/deploy";

test("deploy commands: build and push to Artifact Registry, then a single-instance Cloud Run deploy with secrets", () => {
  const cmds = deployCommands({ project: "p1", region: "us-central1", service: "aido", repo: "aido", tag: "abc123", dataDir: "/abs/data", langfuse: true, modelArmor: { location: "us-central1", template: "aido-pi" }, capUsd: 3 });
  const image = "us-central1-docker.pkg.dev/p1/aido/aido:abc123";
  expect(cmds[0]).toEqual(["docker", "build", "--build-context", "servingdata=/abs/data", "-t", image, "."]);
  expect(cmds[1]).toEqual(["docker", "push", image]);
  const run = cmds[2]!;
  expect(run.slice(0, 4)).toEqual(["gcloud", "run", "deploy", "aido"]);
  const flag = (name: string) => run[run.indexOf(name) + 1];
  expect(flag("--image")).toBe(image);
  expect(flag("--project")).toBe("p1");
  expect(flag("--region")).toBe("us-central1");
  expect(flag("--max-instances")).toBe("1");
  expect(run).toContain("--allow-unauthenticated");
  expect(flag("--set-secrets")).toBe("GEMINI_API_KEY=aido-gemini-api-key:latest,JWT_SECRET=aido-jwt-secret:latest,DEMO_PIN=aido-demo-pin:latest,AGENT_PIN=aido-agent-pin:latest,LANGFUSE_PUBLIC_KEY=aido-langfuse-public-key:latest,LANGFUSE_SECRET_KEY=aido-langfuse-secret-key:latest");
  const envs = flag("--set-env-vars")!;
  expect(envs).toContain("LLM_TOTAL_CAP_USD=3");
  expect(envs).toContain("MODEL_ARMOR_PROJECT=p1");
  expect(envs).toContain("MODEL_ARMOR_LOCATION=us-central1");
  expect(envs).toContain("MODEL_ARMOR_TEMPLATE=aido-pi");
  expect(envs).toContain("DEPLOY_ENV=cloud-run");
  expect(JSON.stringify(cmds)).not.toMatch(/sk-lf-|AIza/);
});

test("integrations are omitted when not requested", () => {
  const run = deployCommands({ project: "p1", region: "r", service: "aido", repo: "aido", tag: "t", dataDir: "/abs/data", langfuse: false, modelArmor: null, capUsd: 3 })[2]!;
  expect(run[run.indexOf("--set-secrets") + 1]).not.toContain("LANGFUSE");
  expect(run[run.indexOf("--set-env-vars") + 1]).not.toContain("MODEL_ARMOR");
});
