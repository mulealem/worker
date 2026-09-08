/**
 * PyGate worker — entry point.
 *
 * Bootstraps:
 *   1. Environment variables (dotenv) — must happen before the auth module
 *      reads WORKER_API_TOKEN.
 *   2. The Express app with the health route (no auth) and the
 *      auth-gated /internal/* + /api/v1/* + /api/sandbox/* routes.
 *   3. The push-driven executor that drains the in-memory queue fed by
 *      dashboard push notifications. NO periodic polling for work.
 *   4. One-shot crash-recovery on boot (single GET, not a loop).
 *
 * The worker has no Drizzle, no R2 credentials, no schema. It exists only to run
 * heavy compute (OCR / QR / PDF / HMAC) and call back to the dashboard
 * for every read and write.
 */
import "dotenv/config";
import express, { type Request, type Response } from "express";
import { healthRouter } from "./routes/health.js";
import { verifyRouter } from "./routes/verify.js";
import { verifierRouter } from "./routes/verifier-run.js";
import { webhookRouter } from "./routes/webhook-deliver.js";
import { dispatchRouter } from "./routes/dispatch.js";
import { requireWorkerApi } from "./auth.js";
import { log } from "./log.js";
import { startWorkers } from "./workers/tick.js";

const logv = log.child({ module: "server" });

const PORT = Number(process.env.PORT ?? 3004);

const app = express();

// Body parsing — JSON for the trigger endpoints, raw octet-stream for
// any future binary uploads. Multipart is handled by multer inside the
// verify router.
app.use(express.json({ limit: "1mb" }));
app.use(express.raw({ type: "application/octet-stream", limit: "12mb" }));

app.use((req, _res, next) => {
  logv.debug(`${req.method} ${req.path}`);
  next();
});

// Unauthenticated /health (mounted at the root).
app.use(healthRouter());

// Authenticated routes. Each router is wrapped with the bearer middleware
// so the request is gated before the handler runs.
app.use("/internal", requireWorkerApi, verifierRouter, webhookRouter);
app.use("/internal", requireWorkerApi, dispatchRouter);
app.use("/api/v1", requireWorkerApi, verifyRouter);
app.use("/api/sandbox", requireWorkerApi, verifyRouter);

// 404 fallthrough
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

const server = app.listen(PORT, () => {
  logv.info(`worker listening on :${PORT}`, {
    dashboardUrl: process.env.DASHBOARD_URL,
  });
  // Push-driven executor — drains the in-memory queue fed by push
  // notifications from the dashboard.
  startWorkers();
  // One-shot crash recovery: pull anything the dashboard enqueued while we
  // were down. Single HTTP GET, not a polling loop.
  void reconcileOnBoot();
});

/**
 * One-shot reconciliation on worker boot. Hits the dashboard's claim
 * endpoint a fixed number of times to seed the local in-memory queue.
 * Not a periodic loop — invoked exactly once per process start.
 */
async function reconcileOnBoot(): Promise<void> {
  const token = process.env.WORKER_API_TOKEN ?? "";
  if (!token) {
    logv.warn(`reconcile skipped: WORKER_API_TOKEN not set`);
    return;
  }
  try {
    // Same PORT the listener above bound to (previously defaulted to 3001,
    // which is the marketing app's port — a latent bug when PORT is unset).
    const res = await fetch(`http://127.0.0.1:${PORT}/internal/dispatch/pending`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      // Bound it — if it stalls, we don't block forever.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logv.warn(`reconcile returned ${res.status}`);
      return;
    }
    const body = (await res.json()) as { seeded: number };
    logv.info(`reconcile seeded ${body.seeded} job(s) from dashboard`);
  } catch (err) {
    logv.warn(
      `reconcile failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function shutdown(signal: string): void {
  logv.info(`received ${signal}, draining`);
  server.close(() => {
    logv.info("server closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
