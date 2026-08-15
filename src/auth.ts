/**
 * Bearer-token authentication for the worker's HTTP API.
 *
 * The token is the shared `WORKER_API_TOKEN` (32+ byte hex string). The
 * dashboard holds the same value and signs its calls with it. The worker
 * uses the same constant-time comparison as `dashboard/lib/internal-api-auth.ts`.
 *
 * Note: the worker exposes a separate `/health` route that does NOT run
 * through this check — monitoring systems can't carry credentials.
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { log } from "./log.js";

const logv = log.child({ module: "auth" });

function parseTokens(): string[] {
  const raw = process.env.WORKER_API_TOKEN ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 32);
}

function constantTimeEquals(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

export function requireWorkerApi(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const tokens = parseTokens();
  if (tokens.length === 0) {
    logv.error("WORKER_API_TOKEN is not configured");
    res.status(503).json({ error: "Worker API not configured" });
    return;
  }

  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const presented = (m[1] ?? "").trim();
  if (!presented) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const matched = tokens.some((t) => constantTimeEquals(t, presented));
  if (!matched) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }
  next();
}