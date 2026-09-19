"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext HMR currently duplicates React when next/link is optimized */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionQueueSnapshot } from "../src/application/action-queue";
import type {
  Article,
  ChannelProfile,
  DashboardStats,
  FeedbackReaction,
  IngestionRun,
  RankedArticle,
  RankingAlgorithmDescriptor,
  User,
} from "../src/domain/model";
import { ensureAnonymousUser, shortUserId } from "./anonymous-user";
import { API_BASE_URL, apiUrl, apiUrlWithQuery } from "./api-url";
const DEFAULT_CHANNEL = { id: "admin-preview", name: "dashboard-preview" };

type RankedSummary = Omit<RankedArticle, "article"> & { article: Omit<Article, "content"> };

interface DashboardSummary {
  user: User;
  stats: DashboardStats;
  runs: IngestionRun[];
  profile: ChannelProfile;
  ranked: RankedSummary[];
  userReactions: Record<string, FeedbackReaction>;
  services: { ranking: string; llm: string; discord: string; ingestionRunning: boolean };
}

interface AlgorithmSummary {
  active: string;
  algorithms: RankingAlgorithmDescriptor[];
}

interface OverviewData {
  dashboard: DashboardSummary;
  queue: ActionQueueSnapshot;
  algorithms: AlgorithmSummary;
}

export function Overview() {
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<OverviewData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (identity: User) => {
    const dashboardUrl = apiUrlWithQuery("/api/dashboard");
    dashboardUrl.searchParams.set("channelId", DEFAULT_CHANNEL.id);
    dashboardUrl.searchParams.set("channelName", DEFAULT_CHANNEL.name);
    dashboardUrl.searchParams.set("userId", identity.id);
    const algorithmsUrl = apiUrlWithQuery("/api/algorithms");
    algorithmsUrl.searchParams.set("channelId", DEFAULT_CHANNEL.id);

    const [dashboardResponse, queueResponse, algorithmsResponse] = await Promise.all([
      fetch(dashboardUrl, { cache: "no-store" }),
      fetch(apiUrl("/api/queue"), { cache: "no-store" }),
      fetch(algorithmsUrl, { cache: "no-store" }),
    ]);
    const failed = [dashboardResponse, queueResponse, algorithmsResponse].find((response) => !response.ok);
    if (failed) throw new Error(`Overview API returned ${failed.status}`);
    setData({
      dashboard: await dashboardResponse.json() as DashboardSummary,
      queue: await queueResponse.json() as ActionQueueSnapshot,
      algorithms: await algorithmsResponse.json() as AlgorithmSummary,
    });
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    let interval: number | undefined;
    void ensureAnonymousUser(API_BASE_URL)
      .then(async (identity) => {
        if (!active) return;
        setUser(identity);
        await load(identity);
        if (!active) return;
        interval = window.setInterval(() => void load(identity).catch(() => undefined), 5_000);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Overview is unavailable");
      });
    return () => {
      active = false;
      if (interval) window.clearInterval(interval);
    };
  }, [load]);

  const currentDate = useMemo(() => new Intl.DateTimeFormat("en", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(new Date()).toUpperCase(), []);

  async function runIngestion() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/ingestion"), { method: "POST" });
      if (!response.ok) throw new Error(`Ingestion returned ${response.status}`);
      await load(user);
    } catch (ingestionError) {
      setError(ingestionError instanceof Error ? ingestionError.message : "Could not run ingestion");
    } finally {
      setBusy(false);
    }
  }

  const dashboard = data?.dashboard;
  const topArticle = dashboard?.ranked[0];
  const latestRun = dashboard?.runs[0];
  const activeAlgorithm = data?.algorithms.algorithms.find((algorithm) => algorithm.id === data.algorithms.active);
  const activeActions = (data?.queue.counts.queued ?? 0) + (data?.queue.counts.running ?? 0);
  const latestAction = data?.queue.actions[0];
  const healthy = !error;

  return (
    <main className="overviewPage">
      <header className="topbar">
        <a className="brand" href="/" aria-label="News Feed Concierge home">
          <span className="brandMark">N</span>
          <span>NEWS FEED CONCIERGE</span>
        </a>
        <nav aria-label="Application sections">
          <a className="active" href="/">Overview</a>
          <a href="/queue">Delivery queue</a>
          <a href="/learning">Learning</a>
          <a href="/algorithms">Algorithms</a>
          <a href="/users">Users</a>
          <a href="/settings/inference">Inference</a>
        </nav>
        <div className="headerStatus">
          <span className="userIdentity" title={user?.id ?? "Creating anonymous identity"}>
            {user ? `${user.name} · ${shortUserId(user.id)}` : "IDENTIFYING…"}
          </span>
          <div className={`systemState ${healthy ? "" : "offline"}`}>
            <i /> {healthy ? "SYSTEM NOMINAL" : "API OFFLINE"}
          </div>
        </div>
      </header>

      <section className="hero overviewHero">
        <div>
          <p className="eyebrow">CONTROL ROOM / {currentDate}</p>
          <h1>Everything important.<br />One glance.</h1>
          <p className="lede">A compact read of learning, processing, delivery, and the algorithm currently making the calls.</p>
        </div>
        <button className="primaryButton" type="button" onClick={() => void runIngestion()} disabled={busy || !user}>
          {busy ? "Collecting full text…" : "Run ingestion now"} <span>{busy ? "·" : "↗"}</span>
        </button>
      </section>

      {error && <div className="errorBanner" role="alert"><strong>Connection issue.</strong> {error}.</div>}

      <section className="metrics" id="overview" aria-label="Application overview metrics">
        <OverviewMetric label="ARTICLES" value={dashboard?.stats.articles} note={`${dashboard?.stats.extracted ?? 0} with full text`} />
        <OverviewMetric label="EVALUATED" value={dashboard?.stats.evaluations} note={dashboard?.services.llm ?? "loading"} />
        <OverviewMetric label="DELIVERED" value={dashboard?.stats.deliveries} note={dashboard?.services.discord ?? "loading"} />
        <OverviewMetric label="ACTIVE WORK" value={data ? activeActions : undefined} note={`${data?.queue.counts.failed ?? 0} failed actions retained`} accent />
      </section>

      <section className="overviewGrid" aria-label="Application area summaries">
        <article className="overviewCard learningOverview">
          <div className="overviewCardHeading">
            <div><p className="eyebrow">LEARNING</p><h2>What the feed believes now</h2></div>
            <span>PROFILE V{dashboard?.profile.version ?? "—"}</span>
          </div>
          <div className="overviewLead">
            <strong>{topArticle ? `${Math.round(topArticle.finalScore * 100)}%` : "—"}</strong>
            <div>
              <span>TOP FIT RIGHT NOW</span>
              <h3>{topArticle?.article.title ?? "Waiting for ranked articles"}</h3>
              <p>{topArticle?.reason ?? "The latest recommendation and its explanation will appear here."}</p>
            </div>
          </div>
          <div className="overviewCardFooter">
            <span>{dashboard?.stats.feedback ?? 0} feedback signals · {Object.keys(dashboard?.userReactions ?? {}).length} yours</span>
            <a href="/learning">Open learning <b>↗</b></a>
          </div>
        </article>

        <article className="overviewCard queueOverview">
          <div className="overviewCardHeading">
            <div><p className="eyebrow">DELIVERY QUEUE</p><h2>Work in motion</h2></div>
            <span className={activeActions > 0 ? "livePill" : ""}>{activeActions} ACTIVE</span>
          </div>
          <div className="overviewCounts">
            <div><strong>{data?.queue.counts.queued ?? "—"}</strong><span>QUEUED</span></div>
            <div><strong>{data?.queue.counts.running ?? "—"}</strong><span>RUNNING</span></div>
            <div><strong>{data?.queue.counts.completed ?? "—"}</strong><span>DONE</span></div>
            <div><strong>{data?.queue.counts.failed ?? "—"}</strong><span>FAILED</span></div>
          </div>
          <div className="overviewLatest">
            <span>LATEST ACTION</span>
            <strong>{latestAction?.label ?? "No process activity yet"}</strong>
            <small>{latestAction ? `${latestAction.status} · ${latestAction.detail}` : "The live process queue is currently quiet."}</small>
          </div>
          <div className="overviewCardFooter"><span>Refreshes every 5 seconds</span><a href="/queue">Open queue <b>↗</b></a></div>
        </article>

        <article className="overviewCard algorithmOverview">
          <div className="overviewCardHeading">
            <div><p className="eyebrow">ALGORITHM</p><h2>Current decision engine</h2></div>
            <span>{data?.algorithms.algorithms.length ?? "—"} REGISTERED</span>
          </div>
          <div className="algorithmSnapshot">
            <span>{data?.algorithms.active ?? "Loading active ranker"}</span>
            <h3>{activeAlgorithm?.displayName ?? dashboard?.services.ranking ?? "Ranking engine"}</h3>
            <p>{activeAlgorithm?.summary ?? "Reading the metadata published by the active ranking component."}</p>
            <div><b>VERSION {activeAlgorithm?.version ?? "—"}</b><b>{dashboard?.services.llm ?? "LLM loading"}</b></div>
          </div>
          <div className="overviewCardFooter"><span>Swappable at the application boundary</span><a href="/algorithms">Inspect algorithms <b>↗</b></a></div>
        </article>

        <article className="overviewCard ingestionOverview">
          <div className="overviewCardHeading">
            <div><p className="eyebrow">INGESTION + DELIVERY</p><h2>Latest collection pass</h2></div>
            <span>{latestRun ? relativeTime(latestRun.finishedAt ?? latestRun.startedAt) : "NOT RUN"}</span>
          </div>
          <div className="ingestionSnapshot">
            <strong>{latestRun ? capitalize(latestRun.status) : "Waiting"}</strong>
            <div><span>{latestRun?.source ? sourceLabel(latestRun.source) : "NO SOURCE"}</span><b>{latestRun?.newCount ?? 0} NEW</b><b>{latestRun?.extractedCount ?? 0} FULL TEXT</b></div>
            <p>{dashboard?.services.ingestionRunning ? "A live ingestion pass is running now." : "The scheduler is idle between collection windows."}</p>
          </div>
          <div className="overviewCardFooter"><span>{dashboard?.stats.deliveries ?? 0} deliveries recorded</span><a href="/queue">Watch processing <b>↗</b></a></div>
        </article>

        <article className="overviewCard userOverview">
          <div className="overviewCardHeading">
            <div><p className="eyebrow">USERS</p><h2>Identity without registration</h2></div>
            <span>{dashboard?.stats.users ?? "—"} KNOWN</span>
          </div>
          <div className="userSnapshot">
            <div>
              <span>THIS BROWSER</span>
              <strong>{dashboard?.user.name ?? user?.name ?? "Creating visitor identity"}</strong>
              <code>{dashboard?.user.id ?? user?.id ?? "—"}</code>
            </div>
            <p>Names are persisted with user records. Browser storage carries only the plain identity ID.</p>
          </div>
          <div className="overviewCardFooter"><span>Custom names · no sign-up</span><a href="/users">Manage users <b>↗</b></a></div>
        </article>
      </section>
    </main>
  );
}

function OverviewMetric({ label, value, note, accent = false }: { label: string; value?: number; note: string; accent?: boolean }) {
  return <article className={accent ? "accentMetric" : ""}><span>{label}</span><strong>{value === undefined ? "—" : value.toLocaleString()}</strong><small>{note}</small></article>;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function sourceLabel(source: string): string {
  return source.replaceAll("-", " ").toUpperCase();
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}S AGO`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}M AGO`;
  return `${Math.round(seconds / 3600)}H AGO`;
}
