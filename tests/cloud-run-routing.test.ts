import assert from "node:assert/strict";
import test from "node:test";
import { upstreamForRequest } from "../src/entrypoints/cloud-run.js";

test("Cloud Run ingress sends API and health paths to Express", () => {
  assert.equal(upstreamForRequest("/api/dashboard?channelId=admin-preview"), "api");
  assert.equal(upstreamForRequest("/api"), "api");
  assert.equal(upstreamForRequest("/health"), "api");
  assert.equal(upstreamForRequest("/healthz"), "api");
});

test("Cloud Run ingress sends application pages and assets to Vinext", () => {
  assert.equal(upstreamForRequest("/"), "dashboard");
  assert.equal(upstreamForRequest("/algorithms"), "dashboard");
  assert.equal(upstreamForRequest("/_next/static/app.js"), "dashboard");
});
