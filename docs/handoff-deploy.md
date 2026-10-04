# Handoff: deploy AIDO to Google Cloud Run

This handoff is self-contained. It assumes no prior context and no local copy of the repository. Paste it into a new session, or follow it by hand.

## What you are deploying

AIDO is an AI-first banking customer-service assistant for the Factored AI & Data Hackathon 2026 (team AIDO). It serves customers in Spanish and Portuguese. It is a single Bun process: an Elysia API, a LangGraph conversation graph and Gemini, and it also serves the built React web app.

- Repository (public): https://github.com/S-kkipie/factored-hackathon-2026-AIDO, branch `main`. It is ready to deploy; the last verified commit is `da1bbb7` or later.
- Target: one Google Cloud Run service with `--max-instances 1`. The container is built locally and pushed to Artifact Registry. Secrets come from Secret Manager.
- Optional integrations, each enabled by a flag:
  - Langfuse trace export (`--langfuse`);
  - Google Model Armor prompt-injection signal (`--model-armor-template`).
- The full runbook is in the repo at `docs/deploy.md`. This handoff tells you what to gather and in what order, and points to the runbook for exact commands.

## Rules you must keep

1. **Never commit or publish the dataset.** That covers `data/`, including `data/serving.sqlite`. The dataset is participant-only and the repository is public. Never commit `.env` either.
2. **Never put secret values in files, commands you paste into shared places, or the repo.** Values go only into Secret Manager, from `printf %s "$VALUE" | gcloud secrets create … --data-file=-`.
3. **Do not use the default PINs `2468`/`1357` for a public URL.** Choose new ones. Share them with the judges out of band.
4. **The in-app spend cap is not a hard limit.** `LLM_TOTAL_CAP_USD=3` resets on every cold start. For a hard limit, use a dedicated Gemini API key and lower its daily quota (see `docs/deploy.md` §5).
5. **Ask the user before** any step that creates billable resources or makes the service public. Confirm the project and region first.

## Information to get from the user before starting

| Item | Notes |
|---|---|
| GCP project ID and region | Billing must be enabled. Default region `us-central1`. |
| Which account to use with `gcloud` | Must have Owner or Editor-level rights to enable APIs, create the service account, set IAM and deploy. |
| A Gemini API key for the deployment | Ideally a new key, dedicated to the deployment. Goes into secret `aido-gemini-api-key`. |
| New demo PIN and agent PIN | Goes into `aido-demo-pin` and `aido-agent-pin`. |
| `serving.sqlite` (about 5 MB) | Two options; see Step 2. |
| Langfuse public and secret keys, and region (EU or US) | Optional, only for `--langfuse`. Project at https://cloud.langfuse.com. |
| Whether to enable Model Armor | Optional. Needs the `modelarmor.googleapis.com` API and a template. |

A JWT secret is generated during setup (`openssl rand -hex 32`); nobody needs to provide one.

## Step 1: Tools and code

You need:
- Bun 1.3 or later (`curl -fsSL https://bun.sh/install | bash`);
- Docker with buildx;
- Google Cloud SDK (`gcloud`), authenticated with `gcloud auth login`;
- git and openssl.

```bash
git clone https://github.com/S-kkipie/factored-hackathon-2026-AIDO.git aido && cd aido
bun install
bun run typecheck && bun test        # expect all tests to pass (456 at da1bbb7); no network or paid calls
```

## Step 2: Get `data/serving.sqlite` (required by the image build)

Choose one option. Either way the file stays local in `data/`, which is gitignored.

- **Option A: copy the file.** Ask the user for a private transfer of `data/serving.sqlite` from the original workstation, and place it at `aido/data/serving.sqlite`.
- **Option B: rebuild it from the organizer dataset.** This needs the organizer's read-only S3 credentials, which are in the organizer's data dictionary and are never in the repo.
  1. Run `cp .env.example .env`.
  2. Fill `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in `.env`.
  3. Run `bun run download && bun run pipeline`. It produces `data/serving.sqlite` plus marts and reports.

To check the file:

```bash
ls -la data/serving.sqlite          # a few MB, a real file (not a symlink)
```

## Step 3: Local container check (no paid calls)

```bash
bun run docker:build                 # builds aido:local; the dataset enters via --build-context servingdata
docker run --rm -d --name aido-check -p 18080:8080 -e JWT_SECRET=$(openssl rand -hex 32) -e GEMINI_API_KEY= aido:local
sleep 3 && curl -s localhost:18080/api/health && curl -s -o /dev/null -w "%{http_code}\n" localhost:18080/login
docker stop aido-check
```

Expected:
- `/api/health` returns `{"ok":true}`;
- `/login` returns `200`;
- `docker stop` finishes in about 1 s.

`GEMINI_API_KEY=` stays empty here on purpose. The app then runs on templates and the keyword router.

## Step 4: One-time GCP setup

Follow `docs/deploy.md` §2 exactly, with `P` set to the project and `R` to the region. In summary:
1. Enable the APIs: run, artifactregistry, secretmanager, and modelarmor if you use it.
2. Create the Artifact Registry repo `aido`, then run `gcloud auth configure-docker R-docker.pkg.dev`.
3. Create the secrets `aido-gemini-api-key`, `aido-jwt-secret`, `aido-demo-pin` and `aido-agent-pin`. Add `aido-langfuse-public-key` and `aido-langfuse-secret-key` if you use Langfuse.
4. Create the service account `aido-runtime@P.iam.gserviceaccount.com`. Grant it `roles/secretmanager.secretAccessor`, and `roles/modelarmor.user` if you use Model Armor.
5. Model Armor only:
   - set the regional endpoint override: `gcloud config set api_endpoint_overrides/modelarmor https://modelarmor.R.rep.googleapis.com/`;
   - create the template `aido-pi`;
   - verify the flags with `gcloud model-armor templates create --help`.
6. Recommended hard spend limit: in the Cloud console, lower the daily quota of the Generative Language API for the dedicated key (`docs/deploy.md` §5).

## Step 5: Deploy

Show the user the dry run first, then execute:

```bash
bun run deploy -- --project P --region R [--langfuse] [--langfuse-base-url https://us.cloud.langfuse.com] [--model-armor-template aido-pi]
bun run deploy -- --project P --region R [same flags] --execute
```

The script runs three commands:
1. `docker build --platform linux/amd64 --build-context servingdata=<data dir> -t R-docker.pkg.dev/P/aido/aido:<git sha> .`;
2. `docker push`;
3. `gcloud run deploy aido`, with these settings:
   - `--allow-unauthenticated --max-instances 1 --memory 1Gi --cpu 1`;
   - `--service-account aido-runtime@…`;
   - secrets from Secret Manager;
   - env vars `LLM_TOTAL_CAP_USD=3`, `DEPLOY_ENV=cloud-run` and the Model Armor settings.

Leave out `--langfuse-base-url` for Langfuse's EU region, which is the default.

## Step 6: Verify and report back

1. Run `curl $URL/api/health`, where `$URL` is the URL printed by `gcloud run deploy`.
2. Open `$URL/login`.
   - Sign in as "Cliente estándar" with the new demo PIN.
   - Ask "¿Cuál es mi saldo?", then "Muéstrame mis movimientos".
   - Report an unrecognized charge from the list, and confirm it with the button. A case `D-…` must appear.
3. Open `$URL/agent` with the agent PIN.
   - In a second browser, as a customer, write "Quiero hablar con un agente".
   - The case appears in the queue. Take it, reply, and close it.
4. Open `$URL/trace/<session>` from "Ver traza": the turns show the router, the policy, the rule ids and the cost.
5. If you deployed with Langfuse: the traces appear in the Langfuse project.
6. Report back to the user:
   - the service URL and the revision name;
   - which integrations are on;
   - where the PINs are stored (never paste the PINs themselves into public places);
   - the quota you set on the Gemini key.

## If something fails

| Symptom | Likely cause and fix |
|---|---|
| The build fails at `COPY --from=servingdata` | `data/serving.sqlite` is missing, or it is a dangling symlink. Redo Step 2, or pass `--data-dir <absolute dir>`. |
| The deploy fails with a secret permission error | `aido-runtime` lacks `roles/secretmanager.secretAccessor`, or a secret name is misspelled. |
| The container exits at start | `JWT_SECRET` is missing or shorter than 32 characters. Check the `aido-jwt-secret` value. |
| The model is never used ("templates + escalation only" in the logs) | The `aido-gemini-api-key` secret is empty or wrong. |
| Model Armor template creation returns 404 | The endpoint override is missing (Step 4.5). |
| No traces appear in Langfuse | The keys are wrong, or the region is wrong (US projects need `--langfuse-base-url https://us.cloud.langfuse.com`). |
| You need to roll back | `gcloud run services update-traffic aido --to-revisions PREV=100 --region R` |

Known limits, which are by design and documented in the README:
- one instance only;
- ops data and the spend ledger live on `/tmp` and reset when the container restarts;
- the deployment uses the synthetic dataset.
