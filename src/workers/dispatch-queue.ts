/**
 * In-process job queue. The ONLY writer is `routes/dispatch.ts` — there is
 * no periodic polling. The work execution loop (`workers/tick.ts`) drains
 * this queue; failures schedule a retry with backoff via a timer.
 *
 * Dedupe is keyed on `idempotencyKey` (if provided) or `jobId`. The same
 * dispatch notification may arrive twice in flight (dashboard retried) and
 * once more from boot reconciliation — both must no-op.
 */

import { log } from "../log.js";

const logv = log.child({ module: "dispatch-queue" });

export interface DispatchJob {
  jobId: string;
  paymentId: string;
  attempts: number;
  maxAttempts: number;
  idempotencyKey?: string;
  /** Epoch ms of the job's FIRST execution attempt — the retry deadline
   * is measured from here, not from each attempt. Set by tick.ts. */
  firstStartedAtMs?: number;
}

interface QueueState {
  /** Jobs ready to be picked up by the executor. */
  pending: DispatchJob[];
  /** Job-ids currently being executed (so a duplicate push doesn't double-run). */
  inFlight: Set<string>;
  /** Idempotency keys we have already accepted (so re-pushes no-op). */
  seenKeys: Set<string>;
  /** Per-job retry timers (so they can be cancelled on shutdown). */
  retryTimers: Map<string, NodeJS.Timeout>;
  /** Is the executor running? (prevents concurrent drain). */
  draining: boolean;
  /** Resolver for the drain promise so callers can `await` it. */
  drainWaiters: Array<() => void>;
}

const state: QueueState = {
  pending: [],
  inFlight: new Set(),
  seenKeys: new Set(),
  retryTimers: new Map(),
  draining: false,
  drainWaiters: [],
};

/** Pure helper exported for tests. */
export function _dedupeKey(job: DispatchJob): string | null {
  // Dedup is by EXPLICIT idempotencyKey only. Job-id is NOT a dedupe key
  // — local retries of the same job must re-execute. The dashboard always
  // supplies an idempotencyKey; local retries pass undefined.
  return job.idempotencyKey ?? null;
}

/**
 * Enqueue a job. Returns `{accepted, deduped}`.
 *  - If the job carries an `idempotencyKey` we've already seen, returns
 *    `{accepted: true, deduped: true}` (caller treats as success).
 *  - Jobs WITHOUT an idempotencyKey (e.g. local retries) are always
 *    enqueued fresh.
 */
export function enqueueLocal(
  job: DispatchJob,
): { accepted: true; deduped: boolean } {
  const key = _dedupeKey(job);
  if (key !== null && state.seenKeys.has(key)) {
    return { accepted: true, deduped: true };
  }
  if (key !== null) state.seenKeys.add(key);
  state.pending.push(job);
  notifyWaiters();
  return { accepted: true, deduped: false };
}

/** Pop the next job to execute, or `null` if empty. */
export function takeNext(): DispatchJob | null {
  const job = state.pending.shift() ?? null;
  if (job) state.inFlight.add(job.jobId);
  return job;
}

/** Mark a job as done (successfully or terminally). Frees the inFlight slot. */
export function markDone(jobId: string): void {
  state.inFlight.delete(jobId);
}

/** Number of jobs waiting. Exported for `/health`. */
export function pendingCount(): number {
  return state.pending.length;
}

/** Number of jobs currently being executed. */
export function inFlightCount(): number {
  return state.inFlight.size;
}

/** Cancel any pending retry timers — call on worker shutdown. */
export function cancelAllRetries(): void {
  for (const t of state.retryTimers.values()) clearTimeout(t);
  state.retryTimers.clear();
}

/**
 * Schedule a retry. Pure: this is just bookkeeping around `setTimeout`.
 * `delayMs` is computed by the caller (exponential backoff, etc.).
 *
 * Each retry is keyed by attempt number so two fires of the same timer
 * collapse into one — but a different attempt number creates a distinct
 * enqueue.
 */
export function scheduleRetry(job: DispatchJob, delayMs: number): void {
  const t = setTimeout(() => {
    state.retryTimers.delete(job.jobId);
    state.inFlight.delete(job.jobId); // free the slot before re-queueing
    enqueueLocal({
      ...job,
      idempotencyKey: `retry:${job.jobId}:${job.attempts}`,
    });
  }, delayMs);
  state.retryTimers.set(job.jobId, t);
  logv.debug(`scheduled retry jobId=${job.jobId} attempts=${job.attempts} in ${delayMs}ms`);
}

/**
 * Drain the queue: returns a promise that resolves the next time a job
 * is available OR the queue is already non-empty right now. Used by the
 * executor loop so it doesn't need to spin on `setInterval`.
 */
export function nextAvailable(): Promise<void> {
  if (state.pending.length > 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    state.drainWaiters.push(resolve);
  });
}

function notifyWaiters(): void {
  const waiters = state.drainWaiters.splice(0);
  for (const w of waiters) w();
}

/** Test-only: reset internal state. */
export function _resetForTests(): void {
  cancelAllRetries();
  state.pending.length = 0;
  state.inFlight.clear();
  state.seenKeys.clear();
  state.drainWaiters.length = 0;
  state.draining = false;
}