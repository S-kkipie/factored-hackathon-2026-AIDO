# Deploy runbook: AIDO on Cloud Run

This runbook deploys the assistant as a single Cloud Run service. The deploy script
(`deploy/deploy.ts`, run via `bun run deploy`) prints the exact `docker` and `gcloud`
commands it would run and, by default, stops there (dry run). Nothing is executed
until you pass `--execute`.

No secret values appear in this document or in the script's output — only secret
*names* (`Secret Manager` resource names) and the placeholder `$VALUE`. Actual
secret values live only in Secret Manager.

## 1. Prerequisites

- `gcloud` (authenticated: `gcloud auth login`) and `docker`, both on your PATH.
- A GCP project with billing enabled. You'll need its project ID (`P`) and a region
  (`R`, e.g. `us-central1`).
- The serving dataset built locally: `bun run pipeline`, which produces
  `data/serving.sqlite`. The image build copies this file in as an additional Docker
  build context named `servingdata` — the same mechanism as the local `docker:build`
  script and the Dockerfile's `COPY --from=servingdata serving.sqlite ./data/serving.sqlite`.
  `bun run deploy` resolves this directory itself via `realpathSync("data")` (override
  with `--data-dir <path>`), so it must exist and be a real file, not a dangling
  symlink.

## 2. One-time setup

Enable the required APIs:

```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com modelarmor.googleapis.com --project P
```

Create the Artifact Registry repository and authorize Docker to push to it:

```bash
gcloud artifacts repositories create aido --repository-format=docker --location=R --project P
gcloud auth configure-docker R-docker.pkg.dev
```

Create the secrets. The deploy script references these Secret Manager names (never
the values) via `--set-secrets`. Required:

```bash
printf %s "$VALUE" | gcloud secrets create aido-gemini-api-key --data-file=- --project P
printf %s "$VALUE" | gcloud secrets create aido-jwt-secret --data-file=- --project P
printf %s "$VALUE" | gcloud secrets create aido-demo-pin --data-file=- --project P
printf %s "$VALUE" | gcloud secrets create aido-agent-pin --data-file=- --project P
```

Only if deploying with `--langfuse`:

```bash
printf %s "$VALUE" | gcloud secrets create aido-langfuse-public-key --data-file=- --project P
printf %s "$VALUE" | gcloud secrets create aido-langfuse-secret-key --data-file=- --project P
```

Grant the Cloud Run runtime service account access to read these secrets:

```bash
gcloud projects add-iam-policy-binding P --member="serviceAccount:SERVICE_ACCOUNT" --role="roles/secretmanager.secretAccessor"
```

If deploying with `--model-armor-template`, also grant Model Armor access:

```bash
gcloud projects add-iam-policy-binding P --member="serviceAccount:SERVICE_ACCOUNT" --role="roles/modelarmor.user"
```

Create the Model Armor template (only if using `--model-armor-template`):

```bash
gcloud model-armor templates create aido-pi --location R --pi-and-jailbreak-filter-settings-enforcement=enabled --pi-and-jailbreak-filter-settings-confidence-level=MEDIUM_AND_ABOVE --project P
```

The exact flags for `gcloud model-armor templates create` change between `gcloud`
releases — check `gcloud model-armor templates create --help` at deploy time rather
than trusting the invocation above verbatim.

Langfuse (only if using `--langfuse`): create a project at
[cloud.langfuse.com](https://cloud.langfuse.com) and copy its public and secret keys
into the `aido-langfuse-public-key` and `aido-langfuse-secret-key` secrets created
above.

## 3. Deploy

Dry run (prints the `docker build`, `docker push` and `gcloud run deploy` commands
without running them):

```bash
bun run deploy -- --project P --region R --langfuse --model-armor-template aido-pi
```

Review the printed commands, then re-run with `--execute` to actually build, push
and deploy:

```bash
bun run deploy -- --project P --region R --langfuse --model-armor-template aido-pi --execute
```

Other flags: `--service` and `--repo` (both default to `aido`), `--tag` (defaults to
the current short git SHA), `--data-dir` (defaults to the real path of `./data`),
`--model-armor-location` (defaults to `--region`), `--cap-usd` (defaults to `3`).

## 4. Verify

After the Cloud Run deploy finishes, `gcloud run deploy` prints the service URL
(`$URL`). Check:

- `curl $URL/api/health` returns a healthy response.
- Open `$URL/login` in a browser and sign in with a demo PIN.
- Complete one chat turn.
- If `--langfuse` was used: the turn's trace is visible in the Langfuse project.
- The trace includes an audit row for `model_armor` (if `--model-armor-template`
  was used).

## 5. Operations notes

- The LLM spend cap (`LLM_TOTAL_CAP_USD`, default 3) applies per container instance
  lifetime: the ledger lives at `/tmp/spend-ledger.sqlite`, which is reset whenever
  the instance restarts.
- `--max-instances 1`: sessions, in-process locks and the circuit breaker are
  per-instance state, not shared across replicas, so the service must stay a single
  instance.
- Ops data (`/tmp/ops.sqlite`) is likewise ephemeral container-local SQLite. The
  production path is Cloud SQL / Postgres; see "Known limitations" in the README.
- Rotate the demo PINs (`aido-demo-pin`, `aido-agent-pin`) before or after any shared
  or public deployment.

## 6. Roll back

```bash
gcloud run services update-traffic aido --to-revisions PREV=100 --region R
```

Replace `PREV` with the prior revision name (`gcloud run revisions list --service aido --region R`).
