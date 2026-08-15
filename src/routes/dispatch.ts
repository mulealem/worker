/**
 * Push-only job-dispatch surface.
 *
 * The dashboard POSTs new verifier jobs here when it enqueues them, and on
 * worker boot the worker makes a SINGLE one-shot GET to `/internal/dispatch/pending`
 * to recover anything enqueued while it was down. There is NO periodic
 * polling from worker → dashboard on this surface; the contract is push.
 *
 * Auth: same `WORKER_API_TOKEN` bearer used everywhere else in the worker.
 *
 * Endpoints:
 *   POST /internal/dispatch/jobs              — dashboard → worker, new job
 *   GET  /internal/dispatch/pending           — worker boot recovery (one-shot)
 *   POST /internal/dispatch/jobs/:jobId/ack   — worker → dashboard, ack receipt
 *                                                (used when worker wants to
 *                                                 reject / defer a job)
 *
 * The actual job execution is owned by `workers/tick.ts`, which drives the
 * in-memory queue fed by these push notifications.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { enqueueLocal } from "../workers/dispatch-queue.js";
import { claimNextVerifierJob } from "../dashboard-client.js";
import { log } from "../log.js";

const logv = log.child({ module: "dispatch" });

const DispatchJobBody = z.object({
  jobId: z.string().min(1).max(128),
  paymentId: z.string().min(1).max(128),
  attempts: z.number().int().min(0).max(100),
  maxAttempts: z.number().int().min(1).max(100),
  /** Optional idempotency token. If the worker has already seen it, ack and no-op. */
  idempotencyKey: z.string().min(1).max(256).optional(),
});

export function dispatchRouter(): Router {
  const r = Router();

  /**
   * Dashboard → worker: "a new verifier job exists."
   *
   * Returns 202 Accepted with `{accepted, deduped}`. The worker commits
   * the job to its local in-memory queue and runs it asynchronously.
   */
  r.post("/dispatch/jobs", (req: Request, res: Response) => {
    const parsed = DispatchJobBody.safeParse(req.body);
    if (!parsed.success) {
      logv.warn(`rejecting malformed dispatch body: ${parsed.error.message}`);
      res.status(400).json({ error: "Malformed dispatch body" });
      return;
    }
    const body = parsed.data;
    const accepted = enqueueLocal({
      jobId: body.jobId,
      paymentId: body.paymentId,
      attempts: body.attempts,
      maxAttempts: body.maxAttempts,
      ...(body.idempotencyKey !== undefined
        ? { idempotencyKey: body.idempotencyKey }
        : {}),
    });
    logv.info(
      `dispatch accepted jobId=${body.jobId} paymentId=${body.paymentId} ` +
        `deduped=${accepted.deduped}`,
    );
    res.status(202).json({ accepted: true, deduped: accepted.deduped });
  });

  /**
   * One-shot recovery call. Worker invokes this ONCE on boot to pick up
   * any jobs the dashboard enqueued while it was offline. NOT a polling
   * endpoint — must only be called from `server.ts` after a clean start.
   *
   * Optional query: `?limit=N` (default 50, capped at 500).
   */
  r.get("/dispatch/pending", async (req: Request, res: Response) => {
    const limitParam = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(1, Math.floor(limitParam)), 500)
      : 50;

    const claimed: Array<{
      jobId: string;
      paymentId: string;
      attempts: number;
      maxAttempts: number;
    }> = [];

    // Drain up to `limit` jobs in a single round. The dashboard's claim
    // endpoint already enforces "single UPDATE WHERE status='PENDING'"
    // atomicity, so this loop is safe.
    for (let i = 0; i < limit; i++) {
      try {
        const claim = await claimNextVerifierJob();
        if (!claim) break;
        claimed.push(claim);
      } catch (err) {
        logv.error(
          `boot reconciliation failed at i=${i}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        break;
      }
    }

    for (const c of claimed) {
      enqueueLocal({
        jobId: c.jobId,
        paymentId: c.paymentId,
        attempts: c.attempts,
        maxAttempts: c.maxAttempts,
        idempotencyKey: `boot:${c.jobId}`,
      });
    }

    logv.info(`boot reconciliation seeded ${claimed.length} job(s)`);
    res.status(200).json({ seeded: claimed.length });
  });

  return r;
}