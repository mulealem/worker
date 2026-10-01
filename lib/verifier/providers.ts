/**
 * Per-provider transport pool factories.
 *
 * Providers that are geo-blocked from the worker host (CBE) or benefit from
 * an in-country fallback (Telebirr, M-Pesa) pull from ONE shared relay pool
 * (`getSharedRelayBalancer()` in relays.ts) instead of per-provider relay
 * slots. Relays are interchangeable — they all speak the same
 * provider-agnostic `/relay/{base64url}` endpoint — and the balancer
 * round-robins across every healthy relay, so adding capacity is a
 * `RELAYS`/`RELAYS_FILE` config change, not a code change.
 *
 * Adapter order still matters within a provider pool: the direct adapter
 * goes first because it's the cheapest path; the shared relay balancer is
 * the fallback. CBE has no direct adapter — it is geo-blocked, so it is
 * relay-only.
 */

import { TransportPool, type PoolConfig } from "./pool.js";
import { directFetchAdapter, type TransportAdapter } from "./transport.js";
import { getSharedRelayBalancer } from "./relays.js";
import type { Provider } from "./types.js";

function poolFor(
  adapters: TransportAdapter[],
  overrides: Partial<PoolConfig> = {},
): TransportPool {
  const cfg: PoolConfig = {
    maxAttempts: numEnv("RETRY_MAX_ATTEMPTS", 4),
    retryDelayMs: numEnv("RETRY_DELAY_MS", 1800),
    // Relayed CBE calls can legitimately take 5-10s (relay hop + CBE itself);
    // a 20s total budget used to force 5s per-attempt aborts that looked like
    // dead relays.
    totalTimeoutMs: numEnv("RELAY_TIMEOUT_MS", 45_000),
    // Must be >= maxAttempts: the breaker counts CONSECUTIVE failures across
    // calls (adapter state persists), and at 2 it cut short a single
    // verification's retry budget after earlier failed runs had already
    // accumulated a failure. At 4, one verification always gets its full
    // retry budget; only repeated all-failure runs open the circuit.
    failureThreshold: numEnv("CIRCUIT_BREAKER_THRESHOLD", 4),
    cooldownMs: numEnv("CIRCUIT_BREAKER_COOLDOWN_MS", 60_000),
    ...overrides,
  };
  return new TransportPool(adapters, cfg);
}

function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const _pools: Partial<Record<Provider, TransportPool>> = {};

export function getProviderPool(provider: Provider): TransportPool {
  const cached = _pools[provider];
  if (cached) return cached;
  // `undefined` (not a definite-assignment bare declaration) because TS can't
  // prove the switch covers every Provider; the guard below turns a future
  // missed case into a loud error instead of returning an unassigned value.
  let pool: TransportPool | undefined;
  // The shared relay balancer is null when no relays are configured —
  // providers then degrade to direct-only (and CBE, which is relay-only,
  // ends up with an empty pool that fails loudly on every verification).
  const relays = getSharedRelayBalancer();
  switch (provider) {
    case "telebirr":
      pool = poolFor([
        directFetchAdapter("telebirr-direct"),
        ...(relays ? [relays] : []),
      ]);
      break;
    case "mpesa":
      pool = poolFor([
        directFetchAdapter("mpesa-direct"),
        ...(relays ? [relays] : []),
      ]);
      break;
    case "cbe":
      // CBE: relay-only. Direct fetch from the worker host is geo-blocked,
      // so we go straight to the shared relay pool (null → empty pool →
      // loud exhausted-pool error so misconfiguration is obvious).
      //
      // "Wait as long as it takes": no pool-level total cap (totalTimeoutMs
      // 0 disables it) — each attempt gets a generous fixed window, since
      // the relay hops to CBE upstream and can legitimately sit on a slow
      // request. Attempts are still bounded by RETRY_MAX_ATTEMPTS. The
      // balancer round-robins each attempt across a different relay, and
      // manages per-relay circuit breakers itself (the pool-level breaker
      // must never trip the shared balancer — other providers depend on it).
      pool = poolFor(relays ? [relays] : [], {
        totalTimeoutMs: numEnv("CBE_RELAY_TOTAL_TIMEOUT_MS", 0),
        perAttemptTimeoutMs: numEnv("CBE_RELAY_ATTEMPT_TIMEOUT_MS", 60_000),
        failureThreshold: Number.POSITIVE_INFINITY,
      });
      break;
    case "boa":
      pool = poolFor([directFetchAdapter("boa-direct")]);
      break;
    case "dashen":
      pool = poolFor([directFetchAdapter("dashen-direct")]);
      break;
    case "awash":
      pool = poolFor([directFetchAdapter("awash-direct")]);
      break;
    case "zemen":
      pool = poolFor([directFetchAdapter("zemen-direct")]);
      break;
    case "cbe-birr":
      pool = poolFor([directFetchAdapter("cbe-birr-direct")]);
      break;
  }
  if (!pool) throw new Error(`No transport pool configured for provider: ${provider}`);
  _pools[provider] = pool;
  return pool;
}

/**
 * Used by `/api/internal/status/probe` to enumerate every configured
 * provider + its adapter stats in one shot.
 */
export function getAllProviderPools(): Array<{ provider: Provider; pool: TransportPool }> {
  return (Object.keys(_pools) as Provider[]).map((p) => ({
    provider: p,
    pool: _pools[p]!,
  }));
}

/** Test-only: reset pool cache so env changes take effect. */
export function _resetProviderPoolsForTests(): void {
  for (const k of Object.keys(_pools)) delete _pools[k as Provider];
}
