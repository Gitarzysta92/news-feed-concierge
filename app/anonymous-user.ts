import type { User } from "../src/domain/model";

const STORAGE_KEY = "news-feed-concierge.user-id";
let identityRequest: Promise<User> | null = null;

export function ensureAnonymousUser(apiUrl: string): Promise<User> {
  if (identityRequest) return identityRequest;
  identityRequest = registerAnonymousUser(apiUrl).catch((error) => {
    identityRequest = null;
    throw error;
  });
  return identityRequest;
}

export function rememberAnonymousUser(user: User): void {
  window.localStorage.setItem(STORAGE_KEY, user.id);
  identityRequest = Promise.resolve(user);
}

async function registerAnonymousUser(apiUrl: string): Promise<User> {
  const storedId = window.localStorage.getItem(STORAGE_KEY);
  const response = await fetch(`${apiUrl}/api/users/anonymous`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(storedId ? { id: storedId } : {}),
  });
  if (!response.ok) throw new Error(`Identity service returned ${response.status}`);
  const user = await response.json() as User;
  rememberAnonymousUser(user);
  return user;
}

export function shortUserId(userId: string): string {
  return userId.slice(0, 8).toUpperCase();
}
