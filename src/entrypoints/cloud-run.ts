import {
  createServer,
  request as createUpstreamRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { startProdServer } from "vinext/server/prod-server";
import { startApplication } from "./all.js";

const API_PORT = 4000;
const DASHBOARD_PORT = 3000;

export function upstreamForRequest(requestUrl = "/"): "api" | "dashboard" {
  const pathname = new URL(requestUrl, "http://localhost").pathname;
  return pathname === "/health" ||
    pathname === "/healthz" ||
    pathname === "/ready" ||
    pathname === "/readyz" ||
    pathname === "/api" ||
    pathname.startsWith("/api/")
    ? "api"
    : "dashboard";
}

async function main() {
  const publicPort = readPort("PORT", 8080);
  if (publicPort === API_PORT || publicPort === DASHBOARD_PORT) {
    throw new Error(`PORT must not be ${API_PORT} or ${DASHBOARD_PORT}`);
  }

  const application = await startApplication({ host: "127.0.0.1", port: API_PORT });
  let dashboard: Awaited<ReturnType<typeof startProdServer>> | undefined;
  let ingress: Server | undefined;

  try {
    dashboard = await startProdServer({
      host: "127.0.0.1",
      port: DASHBOARD_PORT,
      outDir: resolve("dist"),
      silent: true,
    });

    ingress = createServer((request, response) => {
      const target = upstreamForRequest(request.url);
      proxy(request, response, target === "api" ? API_PORT : DASHBOARD_PORT);
    });
    ingress.on("clientError", (error, socket) => {
      console.warn("Cloud Run ingress rejected a malformed request", error.message);
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    await listen(ingress, publicPort);
  } catch (error) {
    if (dashboard) await closeServer(dashboard.server);
    await application.shutdown();
    throw error;
  }

  console.log(`News Feed Concierge listening on http://0.0.0.0:${publicPort}`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; shutting down`);
    await closeServer(ingress);
    await Promise.all([
      closeServer(dashboard.server),
      application.shutdown(),
    ]);
  };

  process.once("SIGINT", () => void shutdown("SIGINT").catch(reportShutdownFailure));
  process.once("SIGTERM", () => void shutdown("SIGTERM").catch(reportShutdownFailure));
}

function proxy(request: IncomingMessage, response: ServerResponse, port: number): void {
  const forwardedHeaders = {
    ...request.headers,
    "x-forwarded-host": request.headers["x-forwarded-host"] ?? request.headers.host,
    "x-forwarded-proto": request.headers["x-forwarded-proto"] ?? "http",
  };
  const upstream = createUpstreamRequest({
    hostname: "127.0.0.1",
    port,
    path: request.url,
    method: request.method,
    headers: forwardedHeaders,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.on("error", (error) => {
    console.error(`Upstream request to port ${port} failed`, error);
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    if (!response.writableEnded) response.end(JSON.stringify({ error: "Upstream service unavailable" }));
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

function readPort(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  const port = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return port;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

function reportShutdownFailure(error: unknown): void {
  console.error("Cloud Run shutdown failed", error);
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
