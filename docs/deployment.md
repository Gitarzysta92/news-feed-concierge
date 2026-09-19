# Deployment

The stack contains the server, PostgreSQL, and an optional example model service.
The model connection uses standard OpenAI Chat Completions, so a separately
hosted compatible endpoint works without another adapter.

## Local stack

```bash
cp compose.env.example .env.compose
# Replace all three SERVICE_* placeholders with independent generated secrets.
docker compose --env-file .env.compose -f compose.yaml -f compose.local.yaml up -d --build
# Provision the example model once; weights persist in the model volume.
docker compose --env-file .env.compose exec model ollama pull qwen2.5:1.5b
```

Open `http://localhost:8080`. The model's health check checks runtime reachability;
semantic evaluation becomes usable after the configured model has been pulled.
The 1.5B example is for trying the deployment; select a model suitable for your
hardware and evaluation quality needs. CPU execution works but can be slow.

For local Compose, supply `SERVICE_PASSWORD_64_INFERENCE_ADMIN` and
`SERVICE_HEX_64_INFERENCE_SETTINGS` in `.env.compose`; Coolify generates them
automatically for the Git-based application. For host development, set
`INFERENCE_ADMIN_TOKEN` and `INFERENCE_SETTINGS_KEY` in `.env` instead. The
admin token needs at least 16 characters; the encryption key needs 64 hex
characters. Open
**Inference** in the dashboard and enter the admin token to edit the endpoint
URL, API key, model, revision, timeout, LLM weight, and candidate limit. Saves
take effect on the next evaluation and persist in PostgreSQL across restarts.
The API key is encrypted in PostgreSQL and never returned to the browser. Keep
the encryption key stable; changing it prevents the server from reading a saved
API key. Environment `OPENAI_*` and `LLM_*` values are initial defaults until
the first panel save. The panel requires PostgreSQL and both admin secrets.

To use an existing model service, remove `COMPOSE_PROFILES=local-model` and set
`OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`. The URL must include `/v1`.
For an endpoint that ignores authentication, use a nonempty placeholder key.
The endpoint must support Chat Completions JSON mode. Set `LLM_PROVIDER=disabled`
to run entirely with base ranking.

For host-based development, start the database/model services with the local
Compose override, set `.env` to host-accessible URLs, run `npm run db:migrate`,
then `npm run dev`. The local override publishes the database on loopback port
5432 and the optional model on loopback port 11434. `dev:api` serves HTTP only;
`dev:backend` also runs workflow execution and scheduling.

Existing `.env` files using `LLM_PROVIDER=codex-gateway` must be updated to
`openai` or `disabled`. Old `CODEX_GATEWAY_*` settings are no longer used. Do not
point this client at an endpoint that only implements asynchronous `/v1/generate`.

## Coolify: Git repository application

1. Push this repository to GitHub, then in the target Coolify project and
   environment choose **+ New → Git repository**. Select the connected GitHub
   source (or the public repository URL) and the branch to deploy.
2. Under **Configuration → General**, choose **Docker Compose** as the Build Pack,
   set **Base Directory** to `/` and **Docker Compose Location** to `compose.yaml`.
   Save and check that Coolify parsed `server`, `database`, and the optional
   `model`. Use the normal Git-based application deployment; leave **Raw Compose
   Deployment** off. The Compose file in Git is the source of truth.
3. Coolify generates `SERVICE_PASSWORD_64_DATABASE`,
   `SERVICE_PASSWORD_64_INFERENCE_ADMIN`, and
   `SERVICE_HEX_64_INFERENCE_SETTINGS` from the variable references in
   `compose.yaml`. The database password is reused to construct `DATABASE_URL`
   inside the stack. Keep those generated values stable across deployments and
   store a secure copy of the encryption key with your database backup. In
   **Environment Variables**, set `DASHBOARD_ORIGIN` to the public HTTPS origin
   (for example `https://news.example.com`). Leave `NEXT_PUBLIC_API_URL` unset;
   the UI and API share one origin. The remaining `OPENAI_*` and `LLM_*` values
   are initial defaults, editable later from the Inference panel.
4. In the **server** service's Domains field, set
   `https://news.example.com:8080` (substitute your hostname). `8080` selects
   the container port for Coolify's proxy; users still connect over standard
   HTTPS. Give neither `database` nor `model` a public domain. Do not use
   `compose.local.yaml` in Coolify; its published ports are only for local use.
5. If using the bundled Ollama example, enable the `local-model` Compose profile
   with `COMPOSE_PROFILES=local-model` in Coolify's environment variables and
   pull the chosen model from its container terminal (for example,
   `ollama pull qwen2.5:1.5b`). If Coolify's Compose invocation does not pass
   profiles through, deploy that service separately or remove its `profiles`
   entry in your repository branch. For an existing OpenAI-compatible endpoint,
   leave the profile unset and enter its URL, key, and model in the panel.
6. Deploy the selected commit. The server runs locked, idempotent migrations
   before starting the UI/API and workflows. Open `/health`, then the dashboard
   and **Inference** panel. The admin token is the generated
   `SERVICE_PASSWORD_64_INFERENCE_ADMIN` value under Environment Variables.
   Verify ingestion, model evaluation, and feedback; restart once to confirm
   settings, data, and pending jobs survive.

Only committed and pushed changes appear in this Git deployment path. Enable
automatic deployments/webhooks for the selected branch in Coolify if desired.
Deploy one server instance; its PostgreSQL ownership lock prevents overlapping
active schedulers.

The inference settings API requires its own admin token. The rest of the API
and administrative dashboard retain the existing POC access model; apply your
intended access controls before making that surface public.

Back up PostgreSQL and test restoring it; a persistent volume alone is not a
backup. Keep database upgrades separate from routine server updates. Model
weights are cached independently of application data. Bump
`OPENAI_MODEL_REVISION` when replacing a model behind the same model name.

## Import existing SQLite data

Stop the old server's writes and background work before taking the final backup.
The importer uses SQLite's backup API for a consistent snapshot and preserves
entity identifiers. It refuses a nonempty PostgreSQL target or a target with an
active server. Test the import on a copy before cutover.

```bash
# DATABASE_URL points to the new, empty PostgreSQL database.
npm run db:migrate
npm run db:import-sqlite -- /absolute/path/to/concierge.sqlite
```

Run these before starting the new server: initial server startup creates an
admin channel, so an already-started target is not empty. For an existing
Cloud Run instance, export its ephemeral SQLite database before stopping/removing
that instance; stop its scheduled writes while producing the final snapshot.
Retain the snapshot and old deployment artifacts until the new deployment has
been verified. A rollback after new writes needs data reconciliation.

The old Cloud Run auto-deployment workflow has been replaced with CI. No cloud
resources are changed by the repository refactor. At cutover, stop the old
Cloud Run bot before enabling the new server's Discord token. Check article,
channel, feedback, delivery, and delivery-target counts after import.

## Verification

```bash
npm run typecheck
npm run lint
# TEST_DATABASE_URL must refer to a disposable/test PostgreSQL database.
# Tests create and remove their own schema, leaving other schemas untouched.
TEST_DATABASE_URL=postgresql://... npm test
npm run build
```

Tests use a local mock Chat Completions endpoint, with no external model charges.
The integration suite covers database concurrency, persisted jobs, lease
recovery, ambiguous delivery protection, and SQLite import. Without
`TEST_DATABASE_URL`, only the PostgreSQL integration suite is skipped.
