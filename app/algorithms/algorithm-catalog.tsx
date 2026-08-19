"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext HMR currently duplicates React when next/link is optimized */

import { useEffect, useState } from "react";
import type {
  RankingAlgorithmDescriptor,
  RankingAlgorithmLiveState,
  RankingAlgorithmParameter,
} from "../../src/domain/model";
import { apiUrlWithQuery } from "../api-url";

interface AlgorithmCatalogPayload {
  active: string;
  algorithms: RankingAlgorithmDescriptor[];
  channels: Array<{ id: string; name: string; revision: number; updatedAt: string }>;
  liveState: RankingAlgorithmLiveState & {
    algorithmId: string;
    channel: { id: string; name: string };
  };
}

export function AlgorithmCatalog() {
  const [data, setData] = useState<AlgorithmCatalogPayload | null>(null);
  const [channelId, setChannelId] = useState("admin-preview");
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      setSyncing(true);
      try {
        const url = apiUrlWithQuery("/api/algorithms");
        url.searchParams.set("channelId", channelId);
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Algorithm API returned ${response.status}`);
        setData(await response.json() as AlgorithmCatalogPayload);
        setError(null);
      } catch (loadError: unknown) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Algorithm catalog is unavailable");
      } finally {
        if (!controller.signal.aborted) setSyncing(false);
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [channelId]);

  return (
    <main className="algorithmPage">
      <header className="topbar">
        <a className="brand" href="/" aria-label="News Feed Concierge home">
          <span className="brandMark">N</span>
          <span>NEWS FEED CONCIERGE</span>
        </a>
        <nav aria-label="Application sections">
          <a href="/">Overview</a>
          <a href="/queue">Delivery queue</a>
          <a href="/learning">Learning</a>
          <a className="active" href="/algorithms">Algorithms</a>
          <a href="/users">Users</a>
        </nav>
        <a className="backLink" href="/">← Control room</a>
      </header>

      <section className="algorithmHero">
        <p className="eyebrow">RANKING CATALOG / SELF-DESCRIBING COMPONENTS</p>
        <h1>Know what<br />made the call.</h1>
        <p className="lede">Every swappable ranker publishes its identity, behavior, learning model, and scoring inputs through the same contract.</p>
      </section>

      {error && <div className="errorBanner" role="alert"><strong>Connection issue.</strong> {error}.</div>}
      {!data && !error && <div className="catalogLoading">Reading registered algorithms…</div>}

      <section className="algorithmCatalog" aria-label="Registered ranking algorithms">
        {data?.algorithms.map((algorithm, index) => {
          const active = data.active === algorithm.id;
          return (
            <article className="algorithmCard" id={algorithm.id} key={algorithm.id}>
              <div className="algorithmIndex">{String(index + 1).padStart(2, "0")}</div>
              <div className="algorithmCardBody">
                <div className="algorithmHeading">
                  <div>
                    <div className="algorithmIdentity">
                      <span>{algorithm.id}</span>
                      <b>v{algorithm.version}</b>
                      {active && <strong>ACTIVE</strong>}
                    </div>
                    <h2>{algorithm.displayName}</h2>
                    <p className="algorithmSummary">{algorithm.summary}</p>
                  </div>
                  <div className="scoreRange">
                    <span>OUTPUT RANGE</span>
                    <strong>{algorithm.scoreRange.min.toFixed(1)}—{algorithm.scoreRange.max.toFixed(1)}</strong>
                  </div>
                </div>

                <p className="algorithmDescription">{algorithm.description}</p>

                <div className="algorithmDetailsGrid">
                  <section>
                    <p className="eyebrow">LEARNING STRATEGY</p>
                    <p>{algorithm.learningStrategy}</p>
                  </section>
                  <section>
                    <p className="eyebrow">CAPABILITIES</p>
                    <ul>
                      {algorithm.capabilities.map((capability) => <li key={capability}>{capability}</li>)}
                    </ul>
                  </section>
                </div>

                {active && data.liveState.algorithmId === algorithm.id && (
                  <section className="liveParameters" aria-live="polite">
                    <div className="liveParametersHeading">
                      <div>
                        <p className="eyebrow"><i /> LIVE PARAMETERS</p>
                        <h3>#{data.liveState.channel.name} · profile v{data.liveState.revision}</h3>
                        <small>
                          Updated {relativeTime(data.liveState.updatedAt)} · refreshes every 5s
                          {syncing ? " · syncing…" : ""}
                        </small>
                      </div>
                      <label>
                        <span>CHANNEL</span>
                        <select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
                          {data.channels.map((channel) => (
                            <option value={channel.id} key={channel.id}>#{channel.name} · v{channel.revision}</option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div className="liveParameterGroups">
                      {data.liveState.groups.map((group) => (
                        <section className="liveParameterGroup" key={group.key}>
                          <div>
                            <h4>{group.label}</h4>
                            <p>{group.description}</p>
                          </div>
                          {group.parameters.length === 0 && (
                            <div className="parameterEmpty">No learned values yet. Reactions will populate this group.</div>
                          )}
                          {group.parameters.map((parameter) => (
                            <ParameterRow parameter={parameter} key={parameter.key} />
                          ))}
                        </section>
                      ))}
                    </div>
                  </section>
                )}

                <section className="featureCatalog">
                  <p className="eyebrow">SCORING INPUTS</p>
                  <div>
                    {algorithm.features.map((feature) => (
                      <article key={feature.key}>
                        <span>{feature.key}</span>
                        <strong>{feature.label}</strong>
                        <p>{feature.description}</p>
                      </article>
                    ))}
                  </div>
                </section>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}

function ParameterRow({ parameter }: { parameter: RankingAlgorithmParameter }) {
  const position = percentage(parameter.value, parameter.min, parameter.max);
  const zero = percentage(0, parameter.min, parameter.max);
  return (
    <div className="liveParameter">
      <div>
        <strong>{parameter.label}</strong>
        <span>{parameter.key}</span>
      </div>
      <div className="parameterTrack" aria-hidden="true">
        <em style={{ left: `${zero}%` }} />
        <i style={{ left: `${position}%` }} />
      </div>
      <b>{formatValue(parameter.value)}</b>
      <small>{parameter.description}</small>
    </div>
  );
}

function percentage(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

function formatValue(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(4)}`;
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}
