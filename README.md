# News Feed Concierge

A proof of concept that collects technical articles, extracts their full text, ranks them for each Discord channel, and learns from a shared reaction vocabulary across Discord and the admin dashboard.

## Run it

Requires Node.js 22.13 or newer.

```bash
cp .env.example .env
npm install
npm run dev
```

The dashboard runs at `http://localhost:3000`; the Express API runs at `http://localhost:4000`. The root page is a compact overview of every application area, while `/learning`, `/queue`, and `/algorithms` provide the detailed workspaces. Click **Run ingestion now** or run `npm run ingest` to collect the first batch.

The Codex Text Gateway and Discord are optional at runtime. Without `CODEX_GATEWAY_API_TOKEN`, ranking falls back cleanly to the selected base algorithm. Without Discord credentials, collection, learning, API routes, and the dashboard remain usable.

## Shape

The business boundary lives under `src/domain`: article/profile models, reaction semantics, algorithm-neutral ranking contracts, and the interpretable online learner. It has no Express, Discord, database, cron, or OpenAI dependencies.

Application use cases under `src/application` coordinate ingestion, ranking, feedback, and delivery. Infrastructure adapters under `src/infrastructure` implement SQLite, Hacker News, DEV Community, HTML extraction, the asynchronous Codex Text Gateway, optional direct OpenAI evaluation, Discord, and cron. `src/entrypoints` contains the HTTP and process edges.

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

## LLM gateway

The default provider is the hosted [Codex Text Gateway](https://codex-text-gateway-941436191445.europe-central2.run.app). Add its bearer token locally:

```dotenv
LLM_PROVIDER=codex-gateway
CODEX_GATEWAY_API_TOKEN=...
```

The adapter submits an asynchronous generation job, polls its status URL, validates the returned JSON against the ranking schema, and cancels jobs that exceed the configured timeout. The gateway worker must also report ready; its authentication lifecycle is documented in [Gitarzysta92/ai-bucket](https://github.com/Gitarzysta92/ai-bucket).

Direct OpenAI evaluation remains available as a swappable alternative through `LLM_PROVIDER=openai` and `OPENAI_API_KEY`.

SQLite uniqueness constraints prevent the same article from being delivered twice to the same Discord channel. Scheduled ingestion and delivery use separate cron expressions; exceptional unseen articles can also trigger randomized serendipity delivery.

## Operation queue

The `/queue` page polls `GET /api/queue` once per second and displays real application actions as they move through `queued`, `running`, `completed`, and `failed`. Ingestion, individual full-text extractions, semantic evaluations, reaction learning, and edge deliveries all report through the same application-level tracker. Recent history is intentionally bounded and process-local, so it resets when the backend restarts; durable ingestion and delivery outcomes remain in SQLite.

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

## Cloud Run deployment

The production container keeps the dashboard and Express API as separate internal
servers, then exposes one Cloud Run ingress port. Requests under `/api` plus the
health endpoints go to Express; application pages and assets go to Vinext.

This POC intentionally keeps SQLite at
`/tmp/news-feed-concierge/concierge.sqlite`. Cloud Run is configured with a
service-level maximum of one instance, a minimum of zero, request-based CPU,
and concurrency one. The database is disposable: a new instance or revision
starts with an empty database.

The GitHub workflow in `.github/workflows/deploy-cloud-run.yml` builds the
container, pushes it to Artifact Registry, and deploys it using GitHub OIDC and
Google Workload Identity Federation. It does not use a service-account JSON
key. The Codex gateway bearer token stays in Google Secret Manager under
`codex-gateway-api-token` and is attached to the Cloud Run revision at runtime.

Bootstrap the Google resources after authenticating the Google Cloud CLI:

```bash
export GCP_PROJECT_ID=your-project-id
export CODEX_GATEWAY_API_TOKEN=your-token
./scripts/bootstrap-gcp.sh
```

The script prints the non-secret variables that must be added to the GitHub
`production` environment. Scheduled `node-cron` work only runs while an
instance is active because the service scales to zero. Discord is disabled
unless its credentials are supplied separately; its long-running gateway
connection is not reliable with this scale-to-zero configuration.
