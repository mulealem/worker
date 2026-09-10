/**
 * Transport pool — orchestrates a list of `TransportAdapter`s with retries,
 * circuit breaker, and a per-call deadline.
 *
 * Behaviour:
 *   - Calls run sequentially through the adapter list, advancing on retryable
 *     failures and stopping on permanent failures (404, 410, 401 from the
 *     relay key, ...).
 *   - Each (adapter, call) gets up to `maxAttempts` attempts with
 *     `retryDelayMs` between them. CBE/M-Pesa API docs suggest 4 attempts.
 *   - The whole call is bounded by `totalTimeoutMs` — adapters that overrun
 *     are abandoned via `AbortSignal.timeout` (which the adapter sets up).
 *   - After `failureThreshold` consecutive failures an adapter is "tripped":
 *     it short-circuits for `cooldownMs` and the pool moves to the next one.
 *   - Returns `PoolOutcome` so the caller can distinguish "verified by
 *     adapter X", "no adapter reachable", and "permanent not-found" without
 *     parsing error strings.
 */

import {
  TransportAdapter,
  TransportError,
  tripAdapterCircuit,
  type AdapterCallResult,
  type AdapterStats,
} from "./transport.js";
import { log } from "..\/log.js";

const logv = log.child({ module: "transport-pool" });

export interface PoolConfig {
  /** Maximum number of attempts PER adapter. Default 4. */
  maxAttempts: number;
  /** Delay between retries on the same adapter (ms). Default 1800. */
  retryDelayMs: number;
  /**
   * Total deadline for the whole pool call (ms). 0 disables the pool-level
   * deadline entirely — attempts run until each adapter's own timeout ends
   * them ("wait as long as it takes").
   */
  totalTimeoutMs: number;
  /**
   * Fixed per-attempt timeout (ms). When set, every attempt gets exactly
   * this window; when unset, the pool's total budget is divided by
   * maxAttempts (bounded 1s..15s) as before.
   */
  perAttemptTimeoutMs?: number;
  /** Consecutive failures before an adapter's circuit opens. Default 4. */
  failureThreshold: number;
  /** Circuit breaker cooldown (ms). Default 60000. */
  cooldownMs: number;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  maxAttempts: 4,
  retryDelayMs: 1800,
  totalTimeoutMs: 45_000,
  failureThreshold: 4,
  cooldownMs: 60_000,
};

export type PoolOutcome =
  | { kind: "ok"; adapterId: string; result: AdapterCallResult; attempts: number }
  | { kind: "permanent_fail"; adapterId: string | null; status: number | null; error: string }
  | { kind: "exhausted"; error: string; adapterErrors: Array<{ id: string; error: string }> };

export class TransportPool {
  private readonly adapters: TransportAdapter[];
  private readonly cfg: PoolConfig;

  constructor(adapters: TransportAdapter[], cfg: Partial<PoolConfig> = {}) {
    this.adapters = adapters;
    this.cfg = { ...DEFAULT_POOL_CONFIG, ...cfg };
  }

  /** Snapshot of every adapter's stats — used by `/api/internal/status/probe`. */
  stats(): AdapterStats[] {
    return this.adapters.map((a) => a.stats());
  }

  /**
   * Call `url` through the adapter chain. `url` is the *upstream* URL —
   * direct adapters fetch it; regional adapters use it as the reference
   * argument to the relay.
   */
  async fetch(url: string): Promise<PoolOutcome> {
    const poolStartedAt = Date.now();
    // totalTimeoutMs === 0 → no pool-level deadline; each attempt is bounded
    // only by its own per-attempt timeout.
    const hasDeadline = this.cfg.totalTimeoutMs > 0;
    const deadline = Date.now() + this.cfg.totalTimeoutMs;
    const adapterErrors: Array<{ id: string; error: string }> = [];

    for (const adapter of this.adapters) {
      if (hasDeadline && Date.now() >= deadline) {
        return {
          kind: "exhausted",
          error: "pool total deadline exceeded",
          adapterErrors,
        };
      }

      const remainingMs = hasDeadline ? deadline - Date.now() : Number.POSITIVE_INFINITY;
      const perAttemptTimeoutMs =
        this.cfg.perAttemptTimeoutMs ??
        Math.max(1_000, Math.min(15_000, Math.floor(remainingMs / this.cfg.maxAttempts)));

      let attempt = 0;
      let lastError: TransportError | null = null;

      while (attempt < this.cfg.maxAttempts) {
        if (hasDeadline && Date.now() >= deadline) break;
        attempt += 1;
        try {
          const result = await adapter.fetch(url, { timeoutMs: perAttemptTimeoutMs });
          logv.info(
            `[transport-pool] adapter=${adapter.id} url=${url} attempt=${attempt}/${this.cfg.maxAttempts} OK ` +
              `status=${result.status} totalElapsedMs=${Date.now() - poolStartedAt}`,
          );
          return { kind: "ok", adapterId: adapter.id, result, attempts: attempt };
        } catch (err) {
          if (!(err instanceof TransportError)) {
            // Re-thrown non-Transport errors are bugs; let them propagate.
            throw err;
          }
          lastError = err;
          logv.warn(
            `[transport-pool] adapter=${adapter.id} url=${url} attempt=${attempt}/${this.cfg.maxAttempts} ` +
              `code=${err.code} status=${err.status ?? "?"} retryable=${err.retryable} ` +
              `message=${err.message}`,
          );
          if (!err.retryable) {
            // Permanent failure on this adapter — record and move to the next.
            adapterErrors.push({ id: adapter.id, error: `${err.code}: ${err.message}` });
            if (
              err.code === "STATUS_4XX" &&
              err.status !== null &&
              err.status >= 400 &&
              err.status < 500
            ) {
              return {
                kind: "permanent_fail",
                adapterId: adapter.id,
                status: err.status,
                error: err.message,
              };
            }
            // Auth/configuration errors — also stop the whole pool, no point
            // trying the next adapter with the same upstream URL.
            if (err.code === "RELAY_AUTH" || err.code === "INVALID_BODY") {
              return {
                kind: "permanent_fail",
                adapterId: adapter.id,
                status: err.status,
                error: err.message,
              };
            }
            break;
          }
          // Trip the circuit if we're accumulating failures.
          const s = adapter.stats();
          if (s.consecutiveFailures >= this.cfg.failureThreshold) {
            tripAdapterCircuit(adapter, this.cfg.cooldownMs);
            adapterErrors.push({ id: adapter.id, error: "circuit opened" });
            logv.warn(
              `[transport-pool] circuit OPENED adapter=${adapter.id} after ` +
                `${s.consecutiveFailures} consecutive failures ` +
                `(threshold=${this.cfg.failureThreshold}, cooldown=${this.cfg.cooldownMs}ms) — ` +
                `subsequent calls skip this adapter until the cooldown ends`,
            );
            break;
          }
          // Retryable — wait before the next attempt.
          if (attempt < this.cfg.maxAttempts) {
            await sleep(
              hasDeadline
                ? Math.min(this.cfg.retryDelayMs, deadline - Date.now())
                : this.cfg.retryDelayMs,
            );
          }
        }
      }

      if (lastError) {
        adapterErrors.push({ id: adapter.id, error: `${lastError.code}: ${lastError.message}` });
      }
    }

    return {
      kind: "exhausted",
      error: "all adapters exhausted",
      adapterErrors,
    };
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}
