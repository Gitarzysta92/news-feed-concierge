"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ChannelProfile,
  DashboardStats,
  Article,
  FeedbackReaction,
  IngestionRun,
  RankedArticle,
  RankingAlgorithmReference,
} from "../src/domain/model";
import type { ReactionDefinition } from "../src/domain/reactions";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface DashboardPayload {
  stats: DashboardStats;
  runs: IngestionRun[];
  channels: ChannelProfile[];
  profile: ChannelProfile;
  ranked: RankedDto[];
  reactions: ReactionDefinition[];
  services: { ranking: string; llm: string; discord: string; ingestionRunning: boolean };
}

type RankedDto = Omit<RankedArticle, "article"> & {
  article: Omit<Article, "content">;
  algorithm: RankingAlgorithmReference;
};

export function Dashboard() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [channel, setChannel] = useState({ id: "admin-preview", name: "dashboard-preview" });
  const [busy, setBusy] = useState(false);
  const [ratingArticle, setRatingArticle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (selected = channel) => {
    try {
      const url = new URL("/api/dashboard", API_URL);
      url.searchParams.set("channelId", selected.id);
      url.searchParams.set("channelName", selected.name);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Dashboard API returned ${response.status}`);
      const payload = await response.json() as DashboardPayload;
      setData(payload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Dashboard API is unavailable");
    }
  }, [channel]);

  useEffect(() => {
    const request = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(request);
  }, [load]);

  const currentDate = useMemo(() => new Intl.DateTimeFormat("en", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(new Date()).toUpperCase(), []);

  async function runIngestion() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/ingestion`, { method: "POST" });
      if (!response.ok) throw new Error(`Ingestion failed with ${response.status}`);
      await load();
    } catch (ingestionError) {
      setError(ingestionError instanceof Error ? ingestionError.message : "Ingestion failed");
    } finally {
      setBusy(false);
    }
  }

  async function rate(articleId: string, reaction: FeedbackReaction) {
    setRatingArticle(articleId);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: channel.id,
          channelName: channel.name,
          articleId,
          actorId: "admin",
          reaction,
        }),
      });
      if (!response.ok) throw new Error(`Feedback failed with ${response.status}`);
      await load();
    } catch (feedbackError) {
      setError(feedbackError instanceof Error ? feedbackError.message : "Feedback failed");
    } finally {
      setRatingArticle(null);
    }
  }

  async function selectChannel(id: string) {
    const selected = data?.channels.find((item) => item.id === id);
    if (!selected) return;
    const next = { id: selected.id, name: selected.name };
    setChannel(next);
    await load(next);
  }

  const stats = data?.stats;
  const latestRun = data?.runs[0];
  const systemHealthy = !error;

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="News Feed Concierge home">
          <span className="brandMark">N</span>
          <span>NEWS FEED CONCIERGE</span>
        </a>
        <nav aria-label="Dashboard sections">
          <a className="active" href="#overview">Overview</a>
          <a href="/queue">Delivery queue</a>
          <a href="#learning">Learning</a>
          <a href="/algorithms">Algorithms</a>
        </nav>
        <div className={`systemState ${systemHealthy ? "" : "offline"}`}>
          <i /> {systemHealthy ? "SYSTEM NOMINAL" : "API OFFLINE"}
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">CONTROL ROOM / {currentDate}</p>
          <h1>The feed is learning.</h1>
          <p className="lede">Live telemetry for collection, evaluation, and channel-level taste.</p>
        </div>
        <button className="primaryButton" type="button" onClick={() => void runIngestion()} disabled={busy}>
          {busy ? "Collecting full text…" : "Run ingestion now"} <span>{busy ? "·" : "↗"}</span>
        </button>
      </section>

      {error && <div className="errorBanner" role="alert"><strong>Connection issue.</strong> {error}. Start the app with <code>npm run dev</code>.</div>}

      <section className="metrics" id="overview" aria-label="Application metrics">
        <Metric label="ARTICLES FETCHED" value={stats?.articles} note={`${stats?.extracted ?? 0} with full text`} />
        <Metric
          label="EVALUATED"
          value={stats?.evaluations}
          note={data ? `${data.services.ranking} · ${data.services.llm}` : "loading"}
        />
        <Metric label="DELIVERED" value={stats?.deliveries} note="duplicate-safe per channel" />
        <Metric label="FEEDBACK SIGNALS" value={stats?.feedback} note={`${stats?.channels ?? 0} learning profiles`} accent />
      </section>

      <div className="dashboardGrid">
        <section className="panel feedPanel" id="ranked">
          <div className="panelHeading">
            <div>
              <p className="eyebrow">RANKED NOW</p>
              <h2>What the concierge sees</h2>
            </div>
            <label className="channelPicker">
              <span>CHANNEL</span>
              <select value={channel.id} onChange={(event) => void selectChannel(event.target.value)}>
                {(data?.channels ?? []).map((item) => <option key={item.id} value={item.id}>#{item.name}</option>)}
              </select>
            </label>
          </div>

          {!data && !error && <div className="emptyState">Reading the latest ranking state…</div>}
          {data && data.ranked.length === 0 && (
            <div className="emptyState">
              <strong>No articles collected yet.</strong>
              Run ingestion to fetch Hacker News and DEV Community, then extract their full text.
            </div>
          )}
          {data?.ranked.slice(0, 6).map((item, index) => (
            <article className="story" key={item.article.id}>
              <div className="rank">{String(index + 1).padStart(2, "0")}</div>
              <div className="storyBody">
                <div className="storyMeta">
                  <span>{item.article.sourceLabel.toUpperCase()}</span>
                  <span>{item.article.contentStatus === "extracted" ? "FULL TEXT" : "SOURCE ONLY"}</span>
                  <span>{Math.round(item.finalScore * 100)}% FIT</span>
                </div>
                <h3><a href={item.article.url} target="_blank" rel="noreferrer">{item.article.title}</a></h3>
                <p>{item.reason}</p>
                <div className="algorithmReference">
                  <div>
                    <span>SCORING ALGORITHM</span>
                    <strong>
                      {item.algorithm?.displayName ?? item.rankingAlgorithm}
                      {item.algorithm && <> <b>v{item.algorithm.version}</b></>}
                    </strong>
                    <small>{item.algorithm?.summary ?? "Refreshing algorithm metadata…"}</small>
                  </div>
                  <a href={`/algorithms#${item.algorithm?.id ?? item.rankingAlgorithm}`}>How it works <span>↗</span></a>
                </div>
                <ol className="processingTrace" aria-label={`Processing status for ${item.article.title}`}>
                  {!item.processing && (
                    <li className="processingStep skipped">
                      <div>
                        <i aria-hidden="true" />
                        <span>Processing trace</span>
                        <strong>refreshing</strong>
                      </div>
                      <small>Waiting for the latest article processing state</small>
                    </li>
                  )}
                  {item.processing?.map((stage) => (
                    <li className={`processingStep ${stage.status}`} key={stage.key}>
                      <div>
                        <i aria-hidden="true" />
                        <span>{stage.label}</span>
                        <strong>{stage.status}</strong>
                      </div>
                      <small>{stage.detail}</small>
                    </li>
                  ))}
                </ol>
                <div className="storyFooter">
                  <div className="reactions" aria-label={`Rate ${item.article.title}`}>
                    {data.reactions.map((definition) => (
                      <button
                        key={definition.reaction}
                        type="button"
                        aria-label={definition.label}
                        title={definition.label}
                        disabled={ratingArticle === item.article.id}
                        onClick={() => void rate(item.article.id, definition.reaction)}
                      >
                        {definition.reaction}
                      </button>
                    ))}
                  </div>
                  <span className="score">
                    BASE {item.base.score.toFixed(2)} <i /> FINAL {item.finalScore.toFixed(2)}
                  </span>
                </div>
              </div>
            </article>
          ))}
        </section>

        <aside className="sideColumn" id="learning">
          <section className="panel learningPanel">
            <div className="panelHeading compact">
              <div>
                <p className="eyebrow">CHANNEL PROFILE</p>
                <h2>#{data?.profile.name ?? channel.name}</h2>
              </div>
              <span className="learningBadge">V{data?.profile.version ?? 1} LEARNING</span>
            </div>
            {Object.entries(data?.profile.weights ?? defaultWeights).map(([feature, weight]) => (
              <div className="weight" key={feature}>
                <span>{featureLabel(feature)}</span>
                <div><i style={{ width: `${Math.min(100, Number(weight) * 100)}%` }} /></div>
                <b>{Number(weight).toFixed(2)}</b>
              </div>
            ))}
            <p className="hint">Every interface uses the same four reactions. Feedback updates this channel only; LLM judgment refines the classic score but never owns it.</p>
            {!!data && Object.keys(data.profile.tagAffinities).length > 0 && (
              <div className="learnedTags">
                <span>LEARNED TOPICS</span>
                {Object.entries(data.profile.tagAffinities)
                  .sort(([, left], [, right]) => Math.abs(right) - Math.abs(left))
                  .slice(0, 5)
                  .map(([tag, affinity]) => <b key={tag}>{tag} {affinity > 0 ? "+" : ""}{affinity.toFixed(2)}</b>)}
              </div>
            )}
          </section>

          <section className="panel runPanel">
            <p className="eyebrow">LATEST INGESTION</p>
            <div className="runTitle">
              <h2>{latestRun ? capitalize(latestRun.status) : "Waiting"}</h2>
              <span>{latestRun?.finishedAt ? relativeTime(latestRun.finishedAt) : "not run"}</span>
            </div>
            <ol>
              {(data?.runs.slice(0, 4) ?? []).map((run) => (
                <li key={run.id}>
                  <i className={run.status === "completed" ? "done" : "pending"} />
                  <span>{sourceLabel(run.source)}</span>
                  <b>{run.newCount} new · {run.extractedCount} full</b>
                </li>
              ))}
              {!data?.runs.length && <li><i className="pending" /><span>No completed runs</span><b>—</b></li>}
            </ol>
          </section>
        </aside>
      </div>
    </main>
  );
}

function Metric({ label, value, note, accent = false }: { label: string; value?: number; note: string; accent?: boolean }) {
  return (
    <article className={accent ? "accentMetric" : ""}>
      <span>{label}</span>
      <strong>{value === undefined ? "—" : value.toLocaleString()}</strong>
      <small>{note}</small>
    </article>
  );
}

const defaultWeights = { topicAffinity: 0.3, freshness: 0.22, novelty: 0.2, sourceQuality: 0.14, popularity: 0.14 };

function featureLabel(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

function sourceLabel(source: string): string {
  if (source === "hacker-news") return "HACKER NEWS";
  if (source === "dev-community") return "DEV COMMUNITY";
  return source.replaceAll("-", " ").toUpperCase();
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}
