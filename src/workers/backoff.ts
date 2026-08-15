/**
 * Backoff schedule for in-process retries after a failed job. Pure
 * helper — no I/O, no `dashboard-client` import — so it can be unit
 * tested in isolation.
 *
 * This is the only timer-driven retry we keep on the worker. It is
 * INTRA-PROCESS bookkeeping after a local job failure, NOT cross-process
 * polling for status. Cross-process work state is always push.
 */

const DEFAULT_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export function backoffMs(attempt: number): number {
  const base = DEFAULT_BACKOFF_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(base, MAX_BACKOFF_MS);
}