"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext HMR currently duplicates React when next/link is optimized */

import { useEffect, useState } from "react";
import type { ActionQueueSnapshot, QueuedAction } from "../../src/application/action-queue";
import { apiUrl } from "../api-url";

export function OperationQueue() {
  const [data, setData] = useState<ActionQueueSnapshot | null>(null);
  const [startingIngestion, setStartingIngestion] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch(apiUrl("/api/queue"), {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Queue API returned ${response.status}`);
        setData(await response.json() as ActionQueueSnapshot);
        setError(null);
      } catch (loadError: unknown) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Queue telemetry is unavailable");
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, []);

  async function runIngestion() {
    setStartingIngestion(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/ingestion"), { method: "POST" });
      if (!response.ok) throw new Error(`Ingestion returned ${response.status}`);
    } catch (ingestionError) {
      setError(ingestionError instanceof Error ? ingestionError.message : "Could not start ingestion");
    } finally {
      setStartingIngestion(false);
    }
  }

  const current = data?.actions.filter((action) => action.status === "queued" || action.status === "running") ?? [];
  const recent = data?.actions.filter((action) => action.status === "completed" || action.status === "failed") ?? [];

  return (
    <main className="queuePage">
      <header className="topbar">
        <a className="brand" href="/" aria-label="News Feed Concierge home">
          <span className="brandMark">N</span>
          <span>NEWS FEED CONCIERGE</span>
        </a>
        <nav aria-label="Application sections">
          <a href="/">Overview</a>
          <a className="active" href="/queue">Delivery queue</a>
          <a href="/learning">Learning</a>
          <a href="/algorithms">Algorithms</a>
          <a href="/users">Users</a>
          <a href="/settings/inference">Inference</a>
        </nav>
        <a className="backLink" href="/">← Control room</a>
      </header>

      <section className="queueHero">
        <div>
          <p className="eyebrow">APPLICATION QUEUE / LIVE PROCESS TELEMETRY</p>
          <h1>Work in motion.</h1>
          <p className="lede">Real queued and running actions from collection, extraction, semantic evaluation, learning, and delivery.</p>
        </div>
        <button className="primaryButton" type="button" onClick={() => void runIngestion()} disabled={startingIngestion}>
          {startingIngestion ? "Ingestion running…" : "Run ingestion"} <span>{startingIngestion ? "·" : "↗"}</span>
        </button>
      </section>

      {error && <div className="errorBanner" role="alert"><strong>Connection issue.</strong> {error}.</div>}

      <section className="queueMetrics" aria-label="Queue metrics">
        <QueueMetric label="QUEUED" value={data?.counts.queued} tone="queued" />
        <QueueMetric label="RUNNING" value={data?.counts.running} tone="running" />
        <QueueMetric label="COMPLETED" value={data?.counts.completed} tone="completed" />
        <QueueMetric label="FAILED" value={data?.counts.failed} tone="failed" />
      </section>

      <section className="queueBoard">
        <div className="queueSectionHeading">
          <div>
            <p className="eyebrow">NOW</p>
            <h2>Currently processed</h2>
          </div>
          <span className="liveRefresh"><i /> refreshes every second</span>
        </div>
        <div className="actionList" aria-live="polite">
          {current.map((action, index) => <ActionRow action={action} index={index} key={action.id} />)}
          {data && current.length === 0 && (
            <div className="queueEmpty">
              <strong>No actions are currently running.</strong>
              Start ingestion, request a semantic feed, react to an article, or run a delivery edge to see work here.
            </div>
          )}
          {!data && !error && <div className="queueEmpty">Reading the process queue…</div>}
        </div>
      </section>

      <section className="queueBoard recentBoard">
        <div className="queueSectionHeading">
          <div>
            <p className="eyebrow">RECENT</p>
            <h2>Completed and failed actions</h2>
          </div>
          <span>{recent.length} retained in this process</span>
        </div>
        <div className="actionList compact">
          {recent.slice(0, 50).map((action, index) => <ActionRow action={action} index={index} key={action.id} />)}
          {data && recent.length === 0 && <div className="queueEmpty">No completed actions in this process yet.</div>}
        </div>
      </section>
    </main>
  );
}

function QueueMetric({ label, value, tone }: {
  label: string;
  value?: number;
  tone: QueuedAction["status"];
}) {
  return (
    <article className={tone}>
      <span>{label}</span>
      <strong>{value === undefined ? "—" : value}</strong>
    </article>
  );
}

function ActionRow({ action, index }: { action: QueuedAction; index: number }) {
  return (
    <article className={`actionRow ${action.status}`}>
      <div className="actionIndex">{String(index + 1).padStart(2, "0")}</div>
      <div className="actionBody">
        <div className="actionMeta">
          <span>{kindLabel(action.kind)}</span>
          <strong><i /> {action.status}</strong>
          <time dateTime={action.startedAt ?? action.queuedAt}>{elapsed(action)}</time>
        </div>
        <h3>{action.label}</h3>
        <p>{action.detail}</p>
        {action.error && <p className="actionError">{action.error}</p>}
        {Object.keys(action.context).length > 0 && (
          <div className="actionContext">
            {Object.entries(action.context).map(([key, value]) => <span key={key}>{key}: {value}</span>)}
          </div>
        )}
      </div>
    </article>
  );
}

function kindLabel(kind: QueuedAction["kind"]): string {
  return kind.replaceAll("-", " ").toUpperCase();
}

function elapsed(action: QueuedAction): string {
  const start = new Date(action.startedAt ?? action.queuedAt).getTime();
  const end = action.finishedAt ? new Date(action.finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
