const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

// Local development keeps the dashboard and API on separate ports. The
// production container exposes both behind one origin, so relative URLs are
// the safest default there.
export const API_BASE_URL = configuredApiUrl
  ? configuredApiUrl.replace(/\/+$/, "")
  : process.env.NODE_ENV === "production"
    ? ""
    : "http://localhost:4000";

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

export function apiUrlWithQuery(path: string): URL {
  return new URL(apiUrl(path), window.location.origin);
}
