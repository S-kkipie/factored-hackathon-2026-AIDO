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

**Never** store the code's defaults (`2468` for `aido-demo-pin`, `1357` for
`aido-agent-pin`) in these secrets: the Cloud Run URL is public (`--allow-unauthenticated`),
so a well-known default PIN is no PIN at all. Choose new, non-guessable PIN values
for `$VALUE` above, and share them with the judges/reviewers out of band (not in this
repo or in the URL).

Only if deploying with `--langfuse`:

```bash
printf %s "$VALUE" | gcloud secrets create aido-langfuse-public-key --data-file=- --project P
printf %s "$VALUE" | gcloud secrets create aido-langfuse-secret-key --data-file=- --project P
```

Create the dedicated runtime service account. The service runs as this identity
(never the Compute Engine default SA), and `bun run deploy` passes it via
`--service-account` (default `aido-runtime@P.iam.gserviceaccount.com`; override with
`--service-account <email>`):

```bash
gcloud iam service-accounts create aido-runtime --display-name "AIDO Cloud Run runtime" --project P
```

Grant it access to read the secrets above:

```bash
gcloud projects add-iam-policy-binding P --member="serviceAccount:aido-runtime@P.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
```

If deploying with `--model-armor-template`, also grant it Model Armor access:

```bash
gcloud projects add-iam-policy-binding P --member="serviceAccount:aido-runtime@P.iam.gserviceaccount.com" --role="roles/modelarmor.user"
```

Model Armor (only if using `--model-armor-template`): point `gcloud` at the regional
endpoint before creating the template — the global endpoint will 404:

```bash
gcloud config set api_endpoint_overrides/modelarmor https://modelarmor.R.rep.googleapis.com/
```

Then create the template. Only the prompt-injection/jailbreak filter is wired up —
the app does not use Model Armor's sensitive-data (SDP) filter, since it masks PII
itself before ever calling Model Armor:

```bash
gcloud model-armor templates create aido-pi --location R --pi-and-jailbreak-filter-settings-enforcement=enabled --pi-and-jailbreak-filter-settings-confidence-level=medium-and-above --project P
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

The image is always built with `docker build --platform linux/amd64` — Cloud Run
only runs amd64, and this flag makes the build reproducible from an Apple Silicon
(arm64) workstation too.

If your Langfuse project is in the US region, pass `--langfuse-base-url
https://us.cloud.langfuse.com` (the default, when omitted, is Langfuse's EU
ingestion endpoint, `https://cloud.langfuse.com`):

```bash
bun run deploy -- --project P --region R --langfuse --langfuse-base-url https://us.cloud.langfuse.com --execute
```

Other flags: `--service` and `--repo` (both default to `aido`), `--tag` (defaults to
the current short git SHA), `--data-dir` (defaults to the real path of `./data`),
`--model-armor-location` (defaults to `--region`), `--cap-usd` (defaults to `3`),
`--service-account` (defaults to `aido-runtime@P.iam.gserviceaccount.com`, the
dedicated runtime SA created in step 2).

If the deploy ends with `Setting IAM policy failed` and adding `allUsers` returns
`do not belong to a permitted customer`, the project's organization enforces Domain
Restricted Sharing. Make the service public without an `allUsers` binding:

```bash
gcloud run services update aido --region R --project P --no-invoker-iam-check
```

## 4. Verify

After the Cloud Run deploy finishes, `gcloud run deploy` prints the service URL
(`$URL`). Check:

- `curl $URL/api/health` returns a healthy response.
- Open `$URL/login` in a browser and sign in with a demo PIN.
- Complete one chat turn.
- If `--langfuse` was used: the turn's trace is visible in the Langfuse project.
- If `--model-armor-template` was used: the `model_armor` audit row lives in the
  app's own trace/audit data (`ops.sqlite`, visible from the app's trace view), not
  in Langfuse — Model Armor's result is recorded as a local audit event, never
  exported over OTLP. Note also that Model Armor is only called when the app's own
  keyword injection heuristic does *not* already flag the turn; if that heuristic
  fires first, Model Armor is skipped for that turn and there is no `model_armor`
  audit row to check.

## 5. Operations notes

- **The in-app LLM spend cap is not a hard limit.** `LLM_TOTAL_CAP_USD` (default 3)
  applies per container instance *lifetime only*: the ledger lives on `/tmp`
  (`/tmp/spend-ledger.sqlite`), and `/tmp` is reset on every cold start. A new
  instance (scale-from-zero, a crash, a redeploy) gets a fresh cap, so this setting
  alone cannot bound total spend over the life of a deployment.

  For an actual hard limit, cap spend at the Google Cloud level instead:
  1. Create a separate, dedicated Gemini API key for this deployment (don't reuse a
     key used elsewhere) and store it in `aido-gemini-api-key`.
  2. In the Cloud console, go to **APIs & Services → Quotas** (or
     `https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas?project=P`).
  3. Filter to the **Generative Language API**.
  4. Find the per-day request-count and/or token-count quota dimensions and edit
     them down to a low value appropriate for the demo's expected traffic.
  5. Submit the quota change (lower-than-default decreases typically apply
     immediately, no approval needed) and confirm the new limit shows as applied.

  This bounds the key's usage at the API level regardless of how many times the
  container restarts and its local ledger resets.
- `--max-instances 1`: sessions, in-process locks and the circuit breaker are
  per-instance state, not shared across replicas, so the service must stay a single
  instance.
- Ops data (`/tmp/ops.sqlite`) is likewise ephemeral container-local SQLite. The
  production path is Cloud SQL / Postgres; see "Known limitations" in the README.
- Rotate the demo PINs (`aido-demo-pin`, `aido-agent-pin`) before or after any shared
  or public deployment — see the warning in step 2 about never deploying with the
  code's default PIN values.

## 6. Roll back

```bash
gcloud run services update-traffic aido --to-revisions PREV=100 --region R
```

Replace `PREV` with the prior revision name (`gcloud run revisions list --service aido --region R`).
