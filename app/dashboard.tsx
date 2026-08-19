"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext HMR currently duplicates React when next/link is optimized */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ChannelProfile,
  DashboardStats,
  Article,
  FeedbackReaction,
  IngestionRun,
  RankedArticle,
  RankingAlgorithmReference,
  User,
} from "../src/domain/model";
import type { ReactionDefinition } from "../src/domain/reactions";
import { ensureAnonymousUser, shortUserId } from "./anonymous-user";
import { API_BASE_URL, apiUrl, apiUrlWithQuery } from "./api-url";

interface DashboardPayload {
  user: User;
  stats: DashboardStats;
  runs: IngestionRun[];
  channels: ChannelProfile[];
  profile: ChannelProfile;
  ranked: RankedDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    unratedOnly: boolean;
  };
  reactions: ReactionDefinition[];
  userReactions: Record<string, FeedbackReaction>;
  services: { ranking: string; llm: string; discord: string; ingestionRunning: boolean };
}

type RankedDto = Omit<RankedArticle, "article"> & {
  article: Omit<Article, "content">;
  algorithm: RankingAlgorithmReference;
};

const PAGE_SIZE = 10;

export function Dashboard() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [channel, setChannel] = useState({ id: "admin-preview", name: "dashboard-preview" });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ratingArticle, setRatingArticle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [unratedOnly, setUnratedOnly] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const load = useCallback(async (
    selected: { id: string; name: string },
    identity: User | null,
    selectedPage: number,
    showUnratedOnly: boolean,
  ) => {
    if (!identity) return;
    setLoading(true);
    try {
      const url = apiUrlWithQuery("/api/dashboard");
      url.searchParams.set("channelId", selected.id);
      url.searchParams.set("channelName", selected.name);
      url.searchParams.set("userId", identity.id);
      url.searchParams.set("page", String(selectedPage));
      url.searchParams.set("pageSize", String(PAGE_SIZE));
      url.searchParams.set("unratedOnly", String(showUnratedOnly));
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Dashboard API returned ${response.status}`);
      const payload = await response.json() as DashboardPayload;
      if (payload.pagination.page > payload.pagination.totalPages) {
        setPage(payload.pagination.totalPages);
        return;
      }
      setData(payload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Dashboard API is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void ensureAnonymousUser(API_BASE_URL)
      .then((identity) => {
        if (!active) return;
        setUser(identity);
        setError(null);
      })
      .catch((identityError) => {
        if (!active) return;
        setError(identityError instanceof Error ? identityError.message : "Could not create an anonymous identity");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const request = window.setTimeout(
      () => void load(channel, user, page, unratedOnly),
      0,
    );
    return () => window.clearTimeout(request);
  }, [channel, load, page, refreshVersion, unratedOnly, user]);

  const currentDate = useMemo(() => new Intl.DateTimeFormat("en", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(new Date()).toUpperCase(), []);

  async function runIngestion() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/ingestion"), { method: "POST" });
      if (!response.ok) throw new Error(`Ingestion failed with ${response.status}`);
      setPage(1);
      setRefreshVersion((current) => current + 1);
    } catch (ingestionError) {
      setError(ingestionError instanceof Error ? ingestionError.message : "Ingestion failed");
    } finally {
      setBusy(false);
    }
  }

  async function rate(articleId: string, reaction: FeedbackReaction) {
    if (!user) return;
    setRatingArticle(articleId);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: channel.id,
          channelName: channel.name,
          articleId,
          userId: user.id,
          reaction,
        }),
      });
      if (!response.ok) throw new Error(`Feedback failed with ${response.status}`);
      const result = await response.json() as { profile: ChannelProfile; changed: boolean };
      setData((current) => {
        if (!current) return current;
        const wasAlreadyRated = Boolean(current.userReactions[articleId]);
        return {
          ...current,
          profile: result.profile,
          stats: {
            ...current.stats,
            feedback: current.stats.feedback + (result.changed && !wasAlreadyRated ? 1 : 0),
          },
          userReactions: { ...current.userReactions, [articleId]: reaction },
        };
      });
    } catch (feedbackError) {
      setError(feedbackError instanceof Error ? feedbackError.message : "Feedback failed");
    } finally {
      setRatingArticle(null);
    }
  }

  function selectChannel(id: string) {
    const selected = data?.channels.find((item) => item.id === id);
    if (!selected) return;
    const next = { id: selected.id, name: selected.name };
    setChannel(next);
    setPage(1);
  }

  const stats = data?.stats;
  const latestRun = data?.runs[0];
  const systemHealthy = !error;
  const pagination = data?.pagination;
  const firstVisible = pagination && pagination.total > 0
    ? (pagination.page - 1) * pagination.pageSize + 1
    : 0;
  const lastVisible = pagination
    ? Math.min(pagination.total, pagination.page * pagination.pageSize)
    : 0;

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="/" aria-label="News Feed Concierge home">
          <span className="brandMark">N</span>
          <span>NEWS FEED CONCIERGE</span>
        </a>
        <nav aria-label="Dashboard sections">
          <a href="/">Overview</a>
          <a href="/queue">Delivery queue</a>
          <a className="active" href="/learning">Learning</a>
          <a href="/algorithms">Algorithms</a>
          <a href="/users">Users</a>
        </nav>
        <div className="headerStatus">
          <span className="userIdentity" title={user?.id ?? "Creating anonymous identity"}>
            {user ? `${user.name} · ${shortUserId(user.id)}` : "IDENTIFYING…"}
          </span>
          <div className={`systemState ${systemHealthy ? "" : "offline"}`}>
            <i /> {systemHealthy ? "SYSTEM NOMINAL" : "API OFFLINE"}
          </div>
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

      <section className="metrics" id="learning-summary" aria-label="Learning metrics">
        <Metric label="ARTICLES FETCHED" value={stats?.articles} note={`${stats?.extracted ?? 0} with full text`} />
        <Metric
          label="EVALUATED"
          value={stats?.evaluations}
          note={data ? `${data.services.ranking} · ${data.services.llm}` : "loading"}
        />
        <Metric label="DELIVERED" value={stats?.deliveries} note="duplicate-safe per channel" />
        <Metric
          label="FEEDBACK SIGNALS"
          value={stats?.feedback}
          note={`${stats?.users ?? 0} visitor identities · ${stats?.channels ?? 0} channel profiles`}
          accent
        />
      </section>

      <div className="dashboardGrid">
        <section className="panel feedPanel" id="ranked">
          <div className="panelHeading">
            <div>
              <p className="eyebrow">LATEST ARTICLES</p>
              <h2>Every article, scored for this channel</h2>
            </div>
            <label className="channelPicker">
              <span>CHANNEL</span>
              <select value={channel.id} onChange={(event) => selectChannel(event.target.value)}>
                {(data?.channels ?? []).map((item) => <option key={item.id} value={item.id}>#{item.name}</option>)}
              </select>
            </label>
          </div>

          <div className="articleBrowseToolbar">
            <div>
              <label className="unratedFilter">
                <input
                  type="checkbox"
                  checked={unratedOnly}
                  onChange={(event) => {
                    setPage(1);
                    setUnratedOnly(event.target.checked);
                  }}
                />
                <span>SHOW UNRATED ONLY</span>
              </label>
              <small>A reaction stays in this snapshot; the next page fetch or refresh applies the filter.</small>
            </div>
            <button
              className="refreshListButton"
              type="button"
              disabled={loading}
              onClick={() => setRefreshVersion((current) => current + 1)}
            >
              {loading ? "Refreshing…" : "Refresh list ↻"}
            </button>
          </div>

          {!data && !error && <div className="emptyState">Reading the latest ranking state…</div>}
          {data && data.ranked.length === 0 && (
            <div className="emptyState">
              <strong>{unratedOnly ? "No unrated articles remain on this page." : "No articles collected yet."}</strong>
              {unratedOnly
                ? "Turn off the filter or refresh after new articles are collected."
                : "Run ingestion to fetch Hacker News and DEV Community, then extract their full text."}
            </div>
          )}
          {data?.ranked.map((item, index) => (
            <article className="story" key={item.article.id}>
              <div className="rank">
                {String((data.pagination.page - 1) * data.pagination.pageSize + index + 1).padStart(2, "0")}
              </div>
              <div className="storyBody">
                <div className="storyMeta">
                  <span>{item.article.sourceLabel.toUpperCase()}</span>
                  <span>{relativeTime(item.article.publishedAt).toUpperCase()}</span>
                  <span>{item.article.contentStatus === "extracted" ? "FULL TEXT" : "SOURCE ONLY"}</span>
                  <span>{item.article.tags.length > 0 ? `TOPICS ${item.article.tags.slice(0, 3).join(" · ")}` : "NO TOPICS"}</span>
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
                        className={data.userReactions[item.article.id] === definition.reaction ? "selected" : ""}
                        aria-pressed={data.userReactions[item.article.id] === definition.reaction}
                        disabled={!user || ratingArticle === item.article.id}
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
          {!!pagination && (
            <nav className="articlePagination" aria-label="Article pages">
              <span>
                {pagination.total === 0
                  ? "NO ARTICLES"
                  : `${firstVisible}–${lastVisible} OF ${pagination.total} · NEWEST FIRST`}
              </span>
              <div>
                <button
                  type="button"
                  disabled={loading || pagination.page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  ← Previous
                </button>
                <b>PAGE {pagination.page} / {pagination.totalPages}</b>
                <button
                  type="button"
                  disabled={loading || pagination.page >= pagination.totalPages}
                  onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))}
                >
                  Next →
                </button>
              </div>
            </nav>
          )}
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
            <p className="hint">
              Your selected reactions are restored for visitor {user ? shortUserId(user.id) : "…"} and stay separate
              from other visitors. Their signals teach this channel profile; LLM judgment refines the base score but
              never owns it.
            </p>
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
