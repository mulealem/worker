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

import { TransportPool } from "./pool.js";
import {
  directFetchAdapter,
  relayFetchAdapter,
  type TransportAdapter,
} from "./transport.js";
import type { Provider } from "./types.js";

/** Common CBE JSON API headers (per the upstream mobile-app receipts). */
const CBE_HEADERS: Record<string, string> = {
  Origin: "https://mbreciept.cbe.com.et",
  Referer: "https://mbreciept.cbe.com.et/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "sec-ch-ua": '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "x-app-id": "d1292e42-7400-49de-a2d3-9731caa4c819",
  "x-app-version": "0a01980b-9859-1369-8198-59f403820000",
};

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

function poolFor(adapters: TransportAdapter[]): TransportPool {
  const cfg = {
    maxAttempts: numEnv("RETRY_MAX_ATTEMPTS", 4),
    retryDelayMs: numEnv("RETRY_DELAY_MS", 1800),
    totalTimeoutMs: numEnv("RELAY_TIMEOUT_MS", 20_000),
    failureThreshold: numEnv("CIRCUIT_BREAKER_THRESHOLD", 2),
    cooldownMs: numEnv("CIRCUIT_BREAKER_COOLDOWN_MS", 60_000),
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
      pool = poolFor([
        directFetchAdapter("cbe-direct", { extraHeaders: CBE_HEADERS }),
      ]);
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
