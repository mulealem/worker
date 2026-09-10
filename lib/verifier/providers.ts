/**
 * Per-provider transport pool factories.
 *
 * Each provider gets a `TransportPool` with:
 *   - a direct fetch adapter (always present),
 *   - any number of regional relay adapters (configured via env).
 *
 * The order matters: adapters are tried in the order returned. The direct
 * adapter goes first because it's the cheapest path; relays are last-resort
 * fallbacks for providers that get blocked from foreign data centers
 * (Telebirr, M-Pesa).
 */

import { TransportPool, type PoolConfig } from "./pool.js";
import {
  directFetchAdapter,
  relayFetchAdapter,
  type TransportAdapter,
} from "./transport.js";
import type { Provider } from "./types.js";

function relayBaseUrl(envVar: string): string | null {
  const v = process.env[envVar];
  if (!v) return null;
  return v.replace(/\/+$/, "");
}

function telebirrRelays(): TransportAdapter[] {
  const adapters: TransportAdapter[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const base = relayBaseUrl(`TELEBIRR_RELAY_URL_${i}`);
    const key = process.env[`TELEBIRR_RELAY_KEY_${i}`];
    if (!base || !key) continue;
    adapters.push(
      relayFetchAdapter(`telebirr-relay-${i}`, {
        relayBaseUrl: base,
        key,
        providerSlug: "telebirr",
      }),
    );
  }
  return adapters;
}

function mpesaRelays(): TransportAdapter[] {
  const adapters: TransportAdapter[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const base = relayBaseUrl(`MPESA_RELAY_URL_${i}`);
    const key = process.env[`MPESA_RELAY_KEY_${i}`];
    if (!base || !key) continue;
    adapters.push(
      relayFetchAdapter(`mpesa-relay-${i}`, {
        relayBaseUrl: base,
        key,
        providerSlug: "mpesa",
      }),
    );
  }
  return adapters;
}

/**
 * CBE relay adapters. Unlike telebirr / m-pesa we deliberately skip the
 * direct adapter for CBE: the worker host (foreign data center) is geo-
 * blocked from `mbreciept.cbe.com.et` / `mb.cbe.com.et`, and routing it
 * through an Ethiopia-hosted relay (e.g. the operator's Plesk proxy at
 * payment.com.et) is the only reliable path.
 *
 * Reads CBE_RELAY_URL_1..4 + CBE_RELAY_KEY_1..4. If none are configured,
 * the resulting pool is empty and any CBE verification will surface an
 * exhausted-pool error — surfaced loudly so misconfiguration is obvious.
 */
function cbeRelays(): TransportAdapter[] {
  const adapters: TransportAdapter[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const base = relayBaseUrl(`CBE_RELAY_URL_${i}`);
    const key = process.env[`CBE_RELAY_KEY_${i}`];
    if (!base || !key) continue;
    adapters.push(
      relayFetchAdapter(`cbe-relay-${i}`, {
        relayBaseUrl: base,
        key,
        providerSlug: "cbe",
      }),
    );
  }
  return adapters;
}

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
  let pool: TransportPool;
  switch (provider) {
    case "telebirr":
      pool = poolFor([
        directFetchAdapter("telebirr-direct"),
        ...telebirrRelays(),
      ]);
      break;
    case "mpesa":
      pool = poolFor([
        directFetchAdapter("mpesa-direct"),
        ...mpesaRelays(),
      ]);
      break;
    case "cbe":
      // CBE: relay-only. Direct fetch from the worker host is geo-blocked,
      // so we go straight to the configured Ethiopia-hosted relay pool.
      //
      // "Wait as long as it takes": no pool-level total cap (totalTimeoutMs
      // 0 disables it) — each attempt gets a generous fixed window, since
      // the relay hops to CBE upstream and can legitimately sit on a slow
      // request. Attempts are still bounded by RETRY_MAX_ATTEMPTS.
      //
      // Circuit breaker DISABLED (threshold = ∞): the breaker counts
      // consecutive failures ACROSS runs, so accumulated failures from
      // earlier verifications used to cut a later run's retries down to a
      // single attempt. Every verification gets — and logs — its full
      // retry budget.
      pool = poolFor([...cbeRelays()], {
        totalTimeoutMs: numEnv("CBE_RELAY_TOTAL_TIMEOUT_MS", 0),
        perAttemptTimeoutMs: numEnv("CBE_RELAY_ATTEMPT_TIMEOUT_MS", 60_000),
        failureThreshold: numEnv(
          "CBE_RELAY_CIRCUIT_BREAKER_THRESHOLD",
          Number.POSITIVE_INFINITY,
        ),
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
