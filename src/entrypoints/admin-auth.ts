import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export function adminAuth(container: {
  config: { inferenceAdminToken?: string };
}): RequestHandler {
  return (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    const expected = container.config.inferenceAdminToken;
    if (!expected || expected.length < 16) {
      response.status(503).json({
        error: "INFERENCE_ADMIN_TOKEN is empty in the server. In Coolify set INFERENCE_ADMIN_TOKEN to the generated SERVICE_PASSWORD_64_INFERENCE_ADMIN value (16+ characters).",
      });
      return;
    }
    const supplied = request.get("authorization")?.replace(/^Bearer /i, "") ?? "";
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(supplied), digest(expected))) {
      response.status(401).json({ error: "Invalid admin token" });
      return;
    }
    next();
  };
}
