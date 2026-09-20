# News Feed Concierge

A proof of concept that collects technical articles, extracts their full text, ranks them for each Discord channel, and learns from a shared reaction vocabulary across Discord and the admin dashboard.

## Run it

Requires Node.js 22.13 or newer.

```bash
cp .env.example .env
npm install
# Start PostgreSQL, set DATABASE_URL and the OpenAI endpoint settings in .env.
npm run db:migrate
npm run dev
```

The dashboard runs at `http://localhost:3000`; the Express API runs at `http://localhost:4000`. The root page is a compact overview of every application area, while `/learning`, `/queue`, `/algorithms`, and `/settings/inference` provide the detailed workspaces. Click **Run ingestion now** or run `npm run ingest` to collect the first batch.

Production runs as three services: **server (UI and workflows)**, **OpenAI-compatible model**,
and **PostgreSQL**. See [deployment instructions](docs/deployment.md) for a complete
local Compose setup and Coolify configuration, and [architecture](docs/architecture.md)
for ownership and failure behavior.

Model evaluation and Discord are optional. Without model credentials, ranking
uses the base algorithm. Without Discord credentials, collection, learning, API
routes, and the dashboard remain usable.

## Shape

The business boundary lives under `src/domain`: article/profile models, reaction semantics, algorithm-neutral ranking contracts, and the interpretable online learner. It has no Express, Discord, database, cron, or OpenAI dependencies.

Application use cases under `src/application` coordinate ingestion, ranking, feedback, and delivery. Infrastructure adapters under `src/infrastructure` implement PostgreSQL (plus legacy SQLite), Hacker News, DEV Community, HTML extraction, OpenAI-compatible evaluation, Discord, and cron. `src/entrypoints` contains the HTTP and process edges.

The hybrid ranker works in this order:

1. The runtime-selected base algorithm scores the article. The default interpretable model uses topic affinity, freshness, novelty, adapter-owned source quality, and popularity.
2. Its score, feature contributions, channel profile, and extracted article text become structured context for the optional LLM evaluator.
3. The final score blends base and semantic scores using `LLM_WEIGHT`.
4. 👍, 🔥, 👎, and 💤 update the same channel profile whether they arrive from Discord or the dashboard.

Article topics are derived from source tags plus bounded title/content classification, with meaningful title keywords as
a fallback. Repeated ingestion preserves topics inferred from full text. Whenever feedback changes, the channel profile
is rebuilt from the current reaction records, so live affinities represent present feedback instead of accumulating
superseded reaction edits.

Dashboard visitors receive an anonymous user record on their first visit without a sign-up step. Only its plain ID is
kept in browser storage; SQLite remains authoritative for the user and reaction records. Reloading restores that
visitor's selected reactions, while another browser identity gets an independent set of choices.
User records also keep a persisted display name. `/users` provides the unauthenticated POC management surface for
reviewing identities and assigning custom names; new anonymous identities receive a readable `Visitor <short-id>` name.

The Learning article inbox pages through the complete corpus newest-first while retaining each article's channel score
and processing trace. Visitors can show only articles they have not rated in that channel. Rating updates the selected
reaction and channel profile in place; the current page remains a stable snapshot, and the filter is applied again on
the next page fetch or explicit refresh.

Every ranked article exposes a five-stage processing trace—collection, full-text extraction, base ranking, semantic evaluation, and finalization. Each stage is explicitly marked `completed`, `skipped`, or `failed`, with the concrete reason visible in the dashboard and API.

`RANKING_ALGORITHM=interpretable-linear-v1` selects the base implementation. Ranking implementations are registered in `src/bootstrap/ranking-algorithm-registry.ts`; the application layer depends only on the `RankingAlgorithm` contract and its generic `RankingScore`.

Every ranking implementation must also publish metadata describing its display name, version, behavior, learning strategy, capabilities, score range, and feature inputs. It implements an algorithm-neutral `inspect(profile)` method for its mutable parameter groups. The registry exposes this self-describing catalog and live per-channel state through `GET /api/algorithms?channelId=...`; the dashboard links each ranked article's compact algorithm reference to the auto-refreshing `/algorithms` catalog.

Content sources are registered independently in `src/bootstrap/content-source-registry.ts`. A new adapter supplies its own stable key, display label, quality signal, and `fetchLatest` implementation—no domain union, dashboard label map, or ranking-algorithm source map needs editing.

## Model service

The server calls a standard OpenAI-compatible `/v1/chat/completions` endpoint.
Prompts, assessment validation, caching, and score blending belong to the server.

```dotenv
LLM_PROVIDER=openai
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_MODEL=qwen2.5:1.5b
```

Use your own compatible endpoint or the optional Ollama service in `compose.yaml`.
The example model must be pulled once as described in the deployment guide.
`OPENAI_MODEL_REVISION` invalidates cached assessments after replacing model weights.
The **Inference** panel edits the endpoint, key, model, timeout, and blending parameters
while the server is running. It requires PostgreSQL, `INFERENCE_ADMIN_TOKEN`, and
`INFERENCE_SETTINGS_KEY`; saved settings override the initial environment values.
See [deployment instructions](docs/deployment.md) for setup.

## Admin API

Operator routes live under `/api/admin` and use the same bearer token as the Inference
panel (`INFERENCE_ADMIN_TOKEN`, 16+ characters). In Coolify, paste the generated
`SERVICE_PASSWORD_64_INFERENCE_ADMIN` value into the editable `INFERENCE_ADMIN_TOKEN`
variable — the Compose mapping row is not the token.

```bash
TOKEN=... # INFERENCE_ADMIN_TOKEN
curl -sS -H "Authorization: Bearer $TOKEN" https://news.example.com/api/admin/status
curl -sS -H "Authorization: Bearer $TOKEN" -X POST https://news.example.com/api/admin/ingestion
curl -sS -H "Authorization: Bearer $TOKEN" -X POST https://news.example.com/api/admin/delivery
```

`GET /api/admin` lists the full catalog. Public `/health` stays unauthenticated.
The dashboard POC routes under `/api` remain open.

## Operation queue

With PostgreSQL configured, ingestion and evaluation run as persistent background
jobs in the server. `POST /api/ingestion` returns `202` with a job ID; `/queue`
shows jobs and persisted activity. Interrupted jobs recover after their lease
expires, and retries use a bounded backoff. Dashboard requests return cached or
base scores without waiting for model generation.

Discord delivery uses durable intents to prevent concurrent sends. Ambiguous
outcomes are marked `uncertain` and require reconciliation before a resend.

## Discord

Create a bot with slash-command and message/reaction access, invite it to the server, then set only its secret token:

```dotenv
DISCORD_BOT_TOKEN=...
```

Guild IDs are discovered from the Discord Gateway when the bot is installed. The bot registers `/news`,
`/concierge-status`, and `/concierge-delivery` separately in every installed server. After installation, a member with
permission to manage the channel runs `/concierge-delivery enable` in each channel that should receive scheduled news;
`/concierge-delivery disable` removes that destination. These channel selections are persisted in SQLite rather than
deployment configuration. The bot adds the four learning reactions to every delivered article.

## Useful commands

```bash
npm run dev             # dashboard + API + worker + optional Discord edge
npm run dev:dashboard   # dashboard only
npm run dev:api         # Express API only
npm run ingest          # one collection run
npm test                # architecture and extension seam tests
npm run build           # dashboard production build + TypeScript check
```

Content comes from the public [Hacker News API](https://github.com/HackerNews/API) and [DEV/Forem API](https://developers.forem.com/api/v1). Full text is fetched from each canonical article URL and stored locally for evaluation.

## Deployment

See [docs/deployment.md](docs/deployment.md) for Coolify, local Compose, backups,
and SQLite-to-PostgreSQL migration. The repository's CI builds and tests the server;
it does not deploy to the old Cloud Run service.
