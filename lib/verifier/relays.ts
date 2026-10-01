/**
 * Shared relay pool — configuration + load balancing.
 *
 * Every provider that needs an Ethiopia-hosted relay (CBE relay-only;
 * Telebirr / M-Pesa as fallback behind their direct adapter) pulls from ONE
 * shared pool of interchangeable relays. Relays speak a single
 * provider-agnostic endpoint (`GET /relay/{base64url upstream URL}`), so any
 * relay can serve any provider and adding capacity is a config change, not a
 * code change.
 *
 * Selection is round-robin over healthy relays — NOT an ordered failover
 * list. The old `RELAY_URL_1..4` scheme sent every request to slot 1 and
 * only moved on after it had burned its whole retry budget; round-robin
 * spreads each successive attempt (including retries of one verification)
 * across different relays, which distributes load and fails over in one
 * attempt instead of four.
 *
 * Per-relay circuit breakers live inside the balancer: after
 * `RELAY_CIRCUIT_BREAKER_THRESHOLD` consecutive failures a relay is skipped
 * for `RELAY_CIRCUIT_BREAKER_COOLDOWN_MS`. The pool-level breaker never
 * trips the balancer as a whole (failureThresholdOverride = Infinity) — one
 * bad relay must not take the other nine offline.
 *
 * Configuration (replaces the per-provider RELAY_URL_1..4 / RELAY_KEY_1..4
 * env vars):
 *
 *   RELAYS=https://r1.example.com|key1,https://r2.example.com|key2
 *
 *   - entries separated by commas or newlines; each entry is `url|key`,
 *     or just `url` when RELAY_SHARED_KEY is set (most deployments share
 *     one key across all relays).
 *   - or RELAYS_FILE=/path/relays.json with either shape:
 *       [{"url": "https://...", "key": "..."}, "https://...|key"]
 *     or {"relays": [ ...same entries... ]}
 *
 * RELAYS_FILE wins when both are set. Relays are tried in config order at
 * first, then rotate.
 */

import fs from "node:fs";
import path from "node:path";
import {
  relayFetchAdapter,
  TransportError,
  tripAdapterCircuit,
  type AdapterStats,
  type TransportAdapter,
} from "./transport.js";
import { log } from "../log.js";

const logv = log.child({ module: "relay-pool" });

export interface RelayConfig {
  /** Relay base URL, no trailing slash, no path suffix. */
  url: string;
  /** x-relay-key secret for this relay; null = none configured. */
  key: string | null;
}

// ---------- config parsing ----------

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!parsed.hostname) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Parse one entry: `url|key` (split on the FIRST `|`, so keys may contain
 * `|`), or a bare `url` that falls back to `globalKey`.
 */
export function parseRelayEntry(
  entry: string,
  globalKey: string | null,
): RelayConfig | { error: string } {
  const trimmed = entry.trim();
  if (!trimmed) return { error: "empty entry" };
  const pipe = trimmed.indexOf("|");
  const rawUrl = pipe === -1 ? trimmed : trimmed.slice(0, pipe);
  const key = pipe === -1 ? globalKey : trimmed.slice(pipe + 1).trim() || null;
  const url = normalizeBaseUrl(rawUrl);
  if (!url) return { error: `invalid relay url: ${rawUrl.slice(0, 80)}` };
  if (!key) return { error: `no key for ${url} (set one per entry or RELAY_SHARED_KEY)` };
  return { url, key };
}

/** Parse the `RELAYS` env var — comma or newline separated entries. */
export function parseRelaysEnv(
  value: string,
  globalKey: string | null,
): { relays: RelayConfig[]; errors: string[] } {
  const relays: RelayConfig[] = [];
  const errors: string[] = [];
  for (const entry of value.split(/[\n,]/)) {
    if (!entry.trim()) continue;
    const parsed = parseRelayEntry(entry, globalKey);
    if ("error" in parsed) errors.push(parsed.error);
    else relays.push(parsed);
  }
  return { relays, errors };
}

/**
 * Parse a relays JSON file. Accepts a top-level array or `{"relays": [...]}`;
 * entries are `"url|key"` / `"url"` strings or `{url, key}` objects.
 */
export function parseRelaysJson(
  json: string,
  globalKey: string | null,
): { relays: RelayConfig[]; errors: string[] } {
  const relays: RelayConfig[] = [];
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (err) {
    return { relays, errors: [`RELAYS_FILE is not valid JSON: ${err instanceof Error ? err.message : err}`] };
  }
  const list = Array.isArray(doc)
    ? doc
    : doc && typeof doc === "object" && Array.isArray((doc as { relays?: unknown[] }).relays)
      ? (doc as { relays: unknown[] }).relays
      : null;
  if (!list) {
    return { relays, errors: ["RELAYS_FILE must be a JSON array or {\"relays\": [...]}"] };
  }
  for (const entry of list) {
    const parsed =
      typeof entry === "string"
        ? parseRelayEntry(entry, globalKey)
        : entry && typeof entry === "object" && typeof (entry as { url?: unknown }).url === "string"
          ? parseRelayEntry(
              (entry as { url: string }).url +
                (typeof (entry as { key?: unknown }).key === "string" && (entry as { key: string }).key
                  ? `|${(entry as { key: string }).key}`
                  : ""),
              globalKey,
            )
          : { error: `unsupported entry: ${JSON.stringify(entry).slice(0, 80)}` };
    if ("error" in parsed) errors.push(parsed.error);
    else relays.push(parsed);
  }
  return { relays, errors };
}

function hasLegacyRelayEnv(): boolean {
  return Object.keys(process.env).some((k) =>
    /^(TELEBIRR|CBE|MPESA)_RELAY_URL_\d+$/.test(k) && process.env[k],
  );
}

/**
 * Load the relay list: RELAYS_FILE wins over RELAYS; neither set (or a file
 * that fails to parse) degrades to whatever RELAYS provides. Logs loudly —
 * an empty list means CBE cannot verify at all and Telebirr / M-Pesa run
 * direct-only.
 */
export function loadRelayConfigs(): { relays: RelayConfig[]; source: string } {
  const globalKey = process.env.RELAY_SHARED_KEY?.trim() || null;
  const filePath = process.env.RELAYS_FILE?.trim();

  if (filePath) {
    try {
      const abs = path.resolve(process.cwd(), filePath);
      const parsed = parseRelaysJson(fs.readFileSync(abs, "utf8"), globalKey);
      for (const e of parsed.errors) logv.warn(`[relay-pool] config: ${e}`);
      if (parsed.relays.length) {
        return { relays: parsed.relays, source: `RELAYS_FILE (${filePath})` };
      }
      logv.warn(`[relay-pool] RELAYS_FILE ${filePath} produced no usable relays — falling back to RELAYS env`);
    } catch (err) {
      logv.warn(
        `[relay-pool] could not read RELAYS_FILE ${filePath}: ${err instanceof Error ? err.message : err} — falling back to RELAYS env`,
      );
    }
  }

  if (process.env.RELAYS?.trim()) {
    const parsed = parseRelaysEnv(process.env.RELAYS, globalKey);
    for (const e of parsed.errors) logv.warn(`[relay-pool] config: ${e}`);
    if (parsed.relays.length) {
      return { relays: parsed.relays, source: "RELAYS env" };
    }
  }

  if (hasLegacyRelayEnv()) {
    logv.warn(
      "[relay-pool] legacy TELEBIRR_/CBE_/MPESA_RELAY_URL_n env vars detected and IGNORED — " +
        "migrate them: RELAYS=https://host1|key1,https://host2|key2 (or RELAYS_FILE=relays.json)",
    );
  }
  return { relays: [], source: "none" };
}

// ---------- balancer ----------

export interface RelayBalancerOptions {
  /** Consecutive failures before one relay is skipped. Default 4. */
  failureThreshold: number;
  /** How long a tripped relay stays skipped (ms). Default 60000. */
  cooldownMs: number;
}

/**
 * One adapter that load-balances across every configured relay. The pool
 * sees a single adapter; each call picks the next healthy relay in
 * round-robin order, so a pool retry naturally lands on a different relay.
 * Per-relay breakers trip inside; the balancer itself is exempt from the
 * pool's breaker via `failureThresholdOverride`.
 */
export function relayBalancerAdapter(
  relays: TransportAdapter[],
  opts: Partial<RelayBalancerOptions> = {},
): TransportAdapter & { relayStats(): AdapterStats[] } {
  const failureThreshold = opts.failureThreshold ?? 4;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  if (relays.length === 0) throw new Error("relayBalancerAdapter requires at least one relay");

  let cursor = 0;
  let totalCalls = 0;
  let totalFailures = 0;
  let latencySumMs = 0;
  let latencySamples = 0;
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;

  function isHealthy(relay: TransportAdapter): boolean {
    const openUntil = relay.stats().circuitOpenUntilMs;
    return openUntil === null || Date.now() >= openUntil;
  }

  return {
    id: "relay-pool",
    role: "regional",
    label: `Relay pool (${relays.length} relays)`,
    failureThresholdOverride: Number.POSITIVE_INFINITY,
    async fetch(url, fetchOpts) {
      // Round-robin over the ring, skipping circuit-open relays. The scan is
      // synchronous (no awaits) so concurrent verifications cannot grab the
      // same slot.
      let picked: TransportAdapter | null = null;
      for (let i = 0; i < relays.length; i += 1) {
        const candidate = relays[(cursor + i) % relays.length];
        if (!isHealthy(candidate)) continue;
        cursor = (cursor + i + 1) % relays.length;
        picked = candidate;
        break;
      }
      if (!picked) {
        totalFailures += 1;
        lastFailureAt = Date.now();
        throw new TransportError(
          "NETWORK",
          `no healthy relays available (all ${relays.length} circuits open)`,
          { retryable: true },
        );
      }
      logv.debug(
        `[relay-pool] pick=${picked.id} of ${relays.length} ` +
          `healthy=${relays.filter(isHealthy).length}/${relays.length} url=${url}`,
      );
      totalCalls += 1;
      const startedAt = Date.now();
      try {
        const result = await picked.fetch(url, fetchOpts);
        latencySumMs += Date.now() - startedAt;
        latencySamples += 1;
        lastSuccessAt = Date.now();
        return result;
      } catch (err) {
        lastFailureAt = Date.now();
        // Trip THIS relay's circuit if it is accumulating consecutive
        // failures; other relays stay in the ring.
        if (err instanceof TransportError) {
          totalFailures += 1;
          const s = picked.stats();
          if (s.consecutiveFailures >= failureThreshold) {
            tripAdapterCircuit(picked, cooldownMs);
            logv.warn(
              `[relay-pool] circuit OPENED relay=${picked.id} after ` +
                `${s.consecutiveFailures} consecutive failures ` +
                `(threshold=${failureThreshold}, cooldown=${cooldownMs}ms)`,
            );
          }
        }
        throw err;
      }
    },
    stats(): AdapterStats {
      return {
        id: "relay-pool",
        role: "regional",
        label: `Relay pool (${relays.length} relays)`,
        totalCalls,
        totalFailures,
        consecutiveFailures: 0,
        averageLatencyMs: latencySamples ? latencySumMs / latencySamples : null,
        lastSuccessAt,
        lastFailureAt,
        circuitOpenUntilMs: null,
      };
    },
    relayStats() {
      return relays.map((r) => r.stats());
    },
  };
}

// ---------- shared singleton ----------

let _balancer: TransportAdapter | null = null;
let _relayConfigs: RelayConfig[] = [];

/**
 * Build (once) the shared relay balancer from RELAYS / RELAYS_FILE. Returns
 * null when no relays are configured — callers degrade (Telebirr / M-Pesa go
 * direct-only; CBE's pool ends up empty and fails loudly).
 */
export function getSharedRelayBalancer(): TransportAdapter | null {
  if (_balancer) return _balancer;
  const { relays, source } = loadRelayConfigs();
  if (!relays.length) {
    if (source === "none") {
      logv.warn(
        "[relay-pool] no relays configured (RELAYS / RELAYS_FILE empty) — " +
          "CBE verifications will fail; Telebirr / M-Pesa run direct-only",
      );
    }
    return null;
  }
  const adapters = relays.map((r, i) => {
    const host = (() => {
      try {
        return new URL(r.url).host;
      } catch {
        return `relay-${i + 1}`;
      }
    })();
    return relayFetchAdapter(`relay-${i + 1}-${host}`, {
      relayBaseUrl: r.url,
      key: r.key ?? "",
    });
  });
  _relayConfigs = relays;
  _balancer = relayBalancerAdapter(adapters, {
    failureThreshold: numEnv("RELAY_CIRCUIT_BREAKER_THRESHOLD", 4),
    cooldownMs: numEnv("RELAY_CIRCUIT_BREAKER_COOLDOWN_MS", 60_000),
  });
  logv.info(
    `[relay-pool] loaded ${relays.length} relay(s) from ${source} ` +
      `(${_relayConfigs.map((r) => hostOf(r.url)).join(", ")})`,
  );
  return _balancer;
}

/** Per-relay stats for the shared balancer — observability/probe endpoints. */
export function getSharedRelayStats(): AdapterStats[] | null {
  if (!_balancer) return null;
  return (_balancer as TransportAdapter & { relayStats(): AdapterStats[] }).relayStats();
}

/** Test-only: drop the cached balancer so env changes take effect. */
export function _resetRelaysForTests(): void {
  _balancer = null;
  _relayConfigs = [];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
