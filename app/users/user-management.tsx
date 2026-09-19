"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext HMR currently duplicates React when next/link is optimized */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "../../src/domain/model";
import { ensureAnonymousUser, rememberAnonymousUser, shortUserId } from "../anonymous-user";
import { API_BASE_URL, apiUrl } from "../api-url";

export function UserManagement() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    const response = await fetch(apiUrl("/api/users?limit=200"), { cache: "no-store" });
    if (!response.ok) throw new Error(`Users API returned ${response.status}`);
    const payload = await response.json() as { users: User[] };
    setUsers(payload.users);
    setDrafts(Object.fromEntries(payload.users.map((user) => [user.id, user.name])));
  }, []);

  useEffect(() => {
    let active = true;
    void ensureAnonymousUser(API_BASE_URL)
      .then(async (identity) => {
        if (!active) return;
        setCurrentUser(identity);
        await loadUsers();
        if (active) setError(null);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "User management is unavailable");
      });
    return () => { active = false; };
  }, [loadUsers]);

  const counts = useMemo(() => ({
    anonymous: users.filter((user) => user.kind === "anonymous").length,
    discord: users.filter((user) => user.kind === "discord").length,
    other: users.filter((user) => user.kind !== "anonymous" && user.kind !== "discord").length,
  }), [users]);

  async function saveName(user: User) {
    const name = drafts[user.id]?.trim();
    if (!name || name === user.name) return;
    setSaving(user.id);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/api/users/${encodeURIComponent(user.id)}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(`Rename returned ${response.status}`);
      const updated = await response.json() as User;
      setUsers((current) => current.map((item) => item.id === updated.id ? updated : item));
      setDrafts((current) => ({ ...current, [updated.id]: updated.name }));
      if (updated.id === currentUser?.id) {
        setCurrentUser(updated);
        rememberAnonymousUser(updated);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the user name");
    } finally {
      setSaving(null);
    }
  }

  return (
    <main className="usersPage">
      <header className="topbar">
        <a className="brand" href="/" aria-label="News Feed Concierge home">
          <span className="brandMark">N</span>
          <span>NEWS FEED CONCIERGE</span>
        </a>
        <nav aria-label="Application sections">
          <a href="/">Overview</a>
          <a href="/queue">Delivery queue</a>
          <a href="/learning">Learning</a>
          <a href="/algorithms">Algorithms</a>
          <a className="active" href="/users">Users</a>
          <a href="/settings/inference">Inference</a>
        </nav>
        <a className="backLink" href="/">← Control room</a>
      </header>

      <section className="usersHero">
        <p className="eyebrow">IDENTITY DIRECTORY / NO SIGN-UP REQUIRED</p>
        <h1>Names, without<br />accounts.</h1>
        <p className="lede">Each visitor receives a durable identity automatically. Give any identity a recognizable name without adding authentication.</p>
      </section>

      {error && <div className="errorBanner" role="alert"><strong>User management issue.</strong> {error}.</div>}

      <section className="userMetrics" aria-label="User metrics">
        <UserMetric label="ALL USERS" value={users.length} />
        <UserMetric label="ANONYMOUS" value={counts.anonymous} />
        <UserMetric label="DISCORD" value={counts.discord} />
        <UserMetric label="SYSTEM + LEGACY" value={counts.other} />
      </section>

      <section className="currentIdentity" aria-label="Current browser identity">
        <div>
          <p className="eyebrow">THIS BROWSER</p>
          <h2>{currentUser?.name ?? "Creating visitor identity…"}</h2>
          <p>The browser keeps only this plain ID. The name and activity stay authoritative in SQLite.</p>
        </div>
        <code>{currentUser?.id ?? "—"}</code>
      </section>

      <section className="userDirectory">
        <div className="userDirectoryHeading">
          <div><p className="eyebrow">USER MANAGEMENT</p><h2>Known identities</h2></div>
          <span>{users.length} RECORDS</span>
        </div>
        <div className="userRows">
          {users.map((user, index) => {
            const changed = drafts[user.id]?.trim() !== user.name;
            const valid = Boolean(drafts[user.id]?.trim());
            return (
              <article className="userRow" key={user.id}>
                <div className="userIndex">{String(index + 1).padStart(2, "0")}</div>
                <div className="userRecord">
                  <div className="userRecordMeta">
                    <span>{user.kind}</span>
                    {user.id === currentUser?.id && <strong>CURRENT VISITOR</strong>}
                    <time dateTime={user.lastSeenAt}>SEEN {relativeTime(user.lastSeenAt)}</time>
                  </div>
                  <div className="userEditor">
                    <label>
                      <span>DISPLAY NAME</span>
                      <input
                        aria-label={`Display name for ${user.id}`}
                        maxLength={60}
                        value={drafts[user.id] ?? user.name}
                        onChange={(event) => setDrafts((current) => ({ ...current, [user.id]: event.target.value }))}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void saveName(user);
                        }}
                      />
                    </label>
                    <button type="button" disabled={!changed || !valid || saving === user.id} onClick={() => void saveName(user)}>
                      {saving === user.id ? "Saving…" : "Save name"}
                    </button>
                  </div>
                  <div className="userRecordFoot">
                    <code>{user.id}</code>
                    <span>CREATED {formatDate(user.createdAt)}</span>
                    <span>SHORT ID {shortUserId(user.id)}</span>
                  </div>
                </div>
              </article>
            );
          })}
          {users.length === 0 && !error && <div className="queueEmpty">Reading persisted user identities…</div>}
        </div>
      </section>
    </main>
  );
}

function UserMetric({ label, value }: { label: string; value: number }) {
  return <article><span>{label}</span><strong>{value}</strong></article>;
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso)).toUpperCase();
}
