"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext HMR currently duplicates React when next/link is optimized */

import { useState, type FormEvent } from "react";
import { apiUrl } from "../../api-url";

interface Settings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  revision: string;
  timeoutMs: number;
  weight: number;
  candidateLimit: number;
  hasApiKey: boolean;
  source: "environment" | "saved";
  updatedAt: string | null;
}

export function InferenceSettingsPanel() {
  const [token, setToken] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function request(method: "GET" | "PUT", body?: object) {
    const response = await fetch(apiUrl("/api/settings/inference"), {
      method,
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json() as Settings & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `Settings request failed (${response.status})`);
    return result;
  }

  async function load() {
    setBusy(true);
    setMessage("");
    try { setSettings(await request("GET")); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not load settings"); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setMessage("");
    try {
      const { hasApiKey, source, updatedAt, ...values } = settings;
      void hasApiKey; void source; void updatedAt;
      setSettings(await request("PUT", { ...values, ...(apiKey ? { apiKey } : {}), clearApiKey }));
      setApiKey("");
      setClearApiKey(false);
      setMessage("Saved. New evaluations now use these settings.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save settings"); }
    finally { setBusy(false); }
  }

  function change<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => current ? { ...current, [key]: value } : current);
  }

  return <main className="inferencePage">
    <header className="topbar">
      <a className="brand" href="/"><span className="brandMark">N</span><span>NEWS FEED CONCIERGE</span></a>
      <nav aria-label="Application sections">
        <a href="/">Overview</a><a href="/queue">Delivery queue</a><a href="/learning">Learning</a>
        <a href="/algorithms">Algorithms</a><a href="/users">Users</a><a className="active" href="/settings/inference">Inference</a>
      </nav>
      <a className="backLink" href="/">← Control room</a>
    </header>
    <section className="hero">
      <div><p className="eyebrow">CONTROL ROOM / SETTINGS</p><h1>Inference endpoint.</h1>
        <p className="lede">Configure the OpenAI-compatible model used for semantic article evaluation. Saved values take effect on the next evaluation.</p></div>
    </section>
    <section className="inferencePanel panel">
      {!settings ? <div className="inferenceFields">
        <h2>Admin access</h2>
        <p>Enter the inference admin token configured on the server. It stays in this page’s memory only.</p>
        <label>Admin token<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label>
        <button className="primaryButton" type="button" disabled={busy || !token} onClick={() => void load()}>Open settings <span>↗</span></button>
      </div> : <form className="inferenceFields" onSubmit={(event) => void save(event)}>
        <div className="inferenceHeading"><div><h2>Live configuration</h2><p>Source: {settings.source}{settings.updatedAt ? ` · saved ${new Date(settings.updatedAt).toLocaleString()}` : ""}</p></div><button type="button" className="quietButton" onClick={() => { setSettings(null); setToken(""); setMessage(""); }}>Lock</button></div>
        <label className="inferenceCheck"><input type="checkbox" checked={settings.enabled} onChange={(event) => change("enabled", event.target.checked)} /> Enable semantic evaluation</label>
        <label>Base URL<input type="url" required value={settings.baseUrl} onChange={(event) => change("baseUrl", event.target.value)} placeholder="https://example.com/v1" /></label>
        <div className="inferenceRow"><label>Model<input required value={settings.model} onChange={(event) => change("model", event.target.value)} /></label><label>Model revision<input required value={settings.revision} onChange={(event) => change("revision", event.target.value)} /></label></div>
        <label>API key <small>{settings.hasApiKey ? "A key is configured. Leave blank to keep it." : "No key configured."}</small><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false); }} placeholder="Leave blank to keep current key" /></label>
        <label className="inferenceCheck"><input type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey(""); }} /> Remove configured API key</label>
        <div className="inferenceRow"><label>Timeout (ms)<input type="number" min="1000" max="600000" required value={settings.timeoutMs} onChange={(event) => change("timeoutMs", Number(event.target.value))} /></label><label>LLM weight (0–1)<input type="number" min="0" max="1" step="0.01" required value={settings.weight} onChange={(event) => change("weight", Number(event.target.value))} /></label><label>Candidate limit<input type="number" min="0" max="25" required value={settings.candidateLimit} onChange={(event) => change("candidateLimit", Number(event.target.value))} /></label></div>
        <button className="primaryButton" type="submit" disabled={busy}>Save settings <span>↗</span></button>
      </form>}
      {message && <p className="inferenceMessage" role="status">{message}</p>}
    </section>
  </main>;
}
