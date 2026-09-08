/**
 * Push-driven execution loop.
 *
 * Replaces the previous `setInterval(1000ms)` polling loop. The executor
 * now idles on `nextAvailable()` (resolved only when the dispatch queue
 * gets a push notification) and runs jobs as they arrive, with at most
 * WORKER_MAX_CONCURRENCY jobs in flight at once.
 *
 * Failure handling:
 *   - On error: schedule a local timer-based retry with exponential backoff
 *     (NOT a poll — this is intra-process bookkeeping).
 *   - On exhausted retries: POST a `fail` to the dashboard so the
 *     VerifierJob row moves to FAILED / DEAD_LETTER.
 *
 * Crash recovery:
 *   - `server.ts` calls `reconcileOnBoot()` once after the listener is up.
 *     This is a SINGLE GET, not a recurring loop.
 *   - Jobs orphaned in PROCESSING by a mid-run crash are recovered by the
 *     dashboard's `/api/cron/verifier-sweep` (external cron), not here.
 *
 * Heartbeats:
 *   - Optional. Disabled by default; enable with `WORKER_HEARTBEAT_MS=10000`.
 *     The heartbeat is a fire-and-forget POST to the dashboard purely for
 *     observability — it carries NO job state.
 */
import {
  postVerifierFail,
  postVerifierRetry,
} from "../dashboard-client.js";
import { runVerifierJob } from "../verifier/run.js";
import { log } from "../log.js";
import {
  cancelAllRetries,
  inFlightCount,
  markDone,
  nextAvailable,
  pendingCount,
  scheduleRetry,
  takeNext,
  type DispatchJob,
} from "./dispatch-queue.js";
import { backoffMs } from "./backoff.js";

const logv = log.child({ module: "tick" });

let executorRunning = false;
let heartbeatTimer: NodeJS.Timeout | null = null;
let started = false;

/**
 * Max jobs executed simultaneously. OCR is CPU-heavy (tesseract + sharp
 * each spawn threads), so without a cap a burst of dispatch pushes would
 * run unbounded concurrent verifications and thrash/OOM the container.
 */
const MAX_CONCURRENT_JOBS = Math.max(
  1,
  Number(process.env.WORKER_MAX_CONCURRENCY ?? 3),
);

function isDisabled(): boolean {
  return process.env.WORKER_DISABLED === "1";
}

async function processOne(job: DispatchJob): Promise<void> {
  const startedAt = Date.now();
  logv.info(
    `running verifier jobId=${job.jobId} paymentId=${job.paymentId} ` +
      `attempt=${job.attempts + 1}/${job.maxAttempts}`,
  );
  try {
    await runVerifierJob({
      jobId: job.jobId,
      paymentId: job.paymentId,
    });
    logv.info(
      `done verifier jobId=${job.jobId} durationMs=${Date.now() - startedAt}`,
    );
    markDone(job.jobId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const nextAttempts = job.attempts + 1;
    const failed = nextAttempts >= job.maxAttempts;
    logv.warn(
      `verifier error jobId=${job.jobId} paymentId=${job.paymentId} ` +
        `attempt=${nextAttempts}/${job.maxAttempts} reason=${msg}` +
        (failed ? " (giving up)" : " (will retry locally)"),
    );
    try {
      if (failed) {
        await postVerifierFail(job.jobId, { lastError: msg });
        markDone(job.jobId);
      } else {
        await postVerifierRetry(job.jobId, { lastError: msg });
        // Schedule a local retry via timer (NOT a poll). The job stays
        // marked in-flight until the timer fires so we don't double-execute.
        scheduleRetry(
          {
            ...job,
            attempts: nextAttempts,
          },
          backoffMs(nextAttempts),
        );
      }
    } catch (postErr) {
      logv.error(
        `failed to post retry/fail for jobId=${job.jobId}: ${
          postErr instanceof Error ? postErr.message : String(postErr)
        }`,
      );
      // Treat as transient; let the local retry timer handle it.
      scheduleRetry(
        { ...job, attempts: nextAttempts },
        backoffMs(nextAttempts),
      );
    }
  }
}

async function executorLoop(): Promise<void> {
  const running = new Set<Promise<void>>();
  while (!isDisabled()) {
    // At capacity: wait for one in-flight job to settle before admitting
    // another (the queue keeps holding any pushes that arrived meanwhile).
    if (running.size >= MAX_CONCURRENT_JOBS) {
      await Promise.race([...running]);
      continue;
    }
    // Idle until the dispatch queue gets a push notification.
    await nextAvailable();
    const job = takeNext();
    if (!job) continue;
    const task = processOne(job).catch((err: unknown) => {
      // processOne handles its own errors; this is a last-resort guard so
      // one bad job can never kill the executor loop.
      logv.error(
        `unhandled job error jobId=${job.jobId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    running.add(task);
    void task.finally(() => {
      running.delete(task);
    });
  }
}

function startHeartbeat(): void {
  const intervalMs = Number(process.env.WORKER_HEARTBEAT_MS ?? 0);
  if (!intervalMs || intervalMs < 1000) return; // disabled by default
  heartbeatTimer = setInterval(() => {
    // Fire-and-forget. We don't care about the response — heartbeats are
    // observability only, never a source of state.
    void import("../dashboard-client.js").then(({ postHeartbeat }) => {
      postHeartbeat({
        pending: pendingCount(),
        inFlight: inFlightCount(),
        uptimeSec: Math.floor(process.uptime()),
      }).catch((err: unknown) => {
        logv.debug(
          `heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }, intervalMs);
  logv.info(`heartbeat enabled every ${intervalMs}ms`);
}

export function startWorkers(): void {
  if (started) return;
  started = true;

  if (isDisabled()) {
    logv.warn(`WORKER_DISABLED=1 — executor will not start.`);
    return;
  }

  logv.info(`starting push-driven executor (no polling)`);
  executorRunning = true;
  void executorLoop();
  startHeartbeat();
}

export function stopWorkers(): void {
  executorRunning = false;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  cancelAllRetries();
  started = false;
  logv.info(`executor stopped`);
}