/**
 * Worker-side `/internal/verifier/run` and `/internal/verifier/run-sync`.
 *
 * - `POST /internal/verifier/run` — fire-and-forget. The dashboard calls
 *   this right after uploading a receipt. Returns 202 immediately; the
 *   actual verifier work happens in the tick loop.
 *
 * - `POST /internal/verifier/run-sync` — for tests/admin re-runs. Runs the
 *   verifier inline and returns the result.
 *
 * Both endpoints require the shared `WORKER_API_TOKEN` (got via the auth
 * middleware in `server.ts`).
 */
import { Router } from "express";
import { z } from "zod";
import { runVerifierJob } from "../verifier/run.js";
import { log } from "../log.js";

const logv = log.child({ module: "verifier-run-route" });

const Body = z.object({
  jobId: z.string().min(1),
  paymentId: z.string().min(1),
});

export const verifierRouter: Router = Router();
// Paths are relative to the mount point in server.ts (`/internal`). Express
// strips the mount prefix before delegating to this router — defining them
// as "/internal/..." would only ever match "/internal/internal/...".

verifierRouter.post("/verifier/run", async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  logv.info(
    `fire-and-forget verifier run job=${parsed.data.jobId} payment=${parsed.data.paymentId}`,
  );
  // Defer to the next tick so the response returns immediately. The main
  // tick loop will pick up the job shortly and process it.
  setImmediate(() => {
    runVerifierJob(parsed.data).catch((err) => {
      logv.error(
        `fire-and-forget run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });
  res.status(202).json({ ok: true, queued: true });
});

verifierRouter.post("/verifier/run-sync", async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  try {
    const outcome = await runVerifierJob(parsed.data);
    res.json({ ok: true, ...outcome });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logv.error(`sync run failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
});
