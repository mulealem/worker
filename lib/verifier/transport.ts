/**
 * Transport adapter abstraction for outbound fetches to bank APIs and
 * receipt pages.
 *
 * Every fetch the verifier makes (CBE, Dashen, BoA, Telebirr, M-Pesa, …)
 * goes through a `TransportAdapter` so we can layer:
 *
 *   - direct fetch from the main server,
 *   - one or more regional relay fetches (hosted in Ethiopia),
 *
 * on top of each other without touching the per-provider parser code.
 *
 * Design rules:
 *   - TLS verification is always on (no `rejectUnauthorized: false`).
 *   - Adapters must throw with a stable `.code` so the pool can distinguish
 *     "retryable network error" from "permanent not found".
 *   - Adapters must never log full request/response bodies.
 *   - Adapters must report `.stats()` for the admin probe endpoint.
 */

import { log } from "..\/log.js";

export type TransportRole = "primary" | "regional";

export interface AdapterStats {
  id: string;
  role: TransportRole;
  label: string;
  totalCalls: number;
  totalFailures: number;
  consecutiveFailures: number;
  averageLatencyMs: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  circuitOpenUntilMs: number | null;
}

export interface AdapterCallResult {
  body: string;
  status: number;
  contentType: string | null;
}

export class TransportError extends Error {
  readonly code:
    | "NETWORK"
    | "TIMEOUT"
    | "STATUS_4XX"
    | "STATUS_5XX"
    | "INVALID_BODY"
    | "RELAY_BAD_RESPONSE"
    | "RELAY_AUTH";
  readonly status: number | null;
  readonly retryable: boolean;
  override readonly cause?: unknown;
  constructor(
    code: TransportError["code"],
    message: string,
    opts: { status?: number | null; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.status = opts.status ?? null;
    this.retryable = opts.retryable ?? false;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export interface TransportAdapter {
  readonly id: string;
  readonly role: TransportRole;
  readonly label: string;
  /**
   * Fetch a URL using this adapter's strategy (direct fetch, regional
   * relay, …). Returns body + status. Throws `TransportError` on failure.
   */
  fetch(url: string, opts?: { timeoutMs?: number }): Promise<AdapterCallResult>;
  stats(): AdapterStats;
}

/** Common browser-style headers — all transports send these. */
const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/125.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
  DNT: "1",
};

/**
 * Direct fetch adapter. Uses Node's global `fetch` with the system trust
 * store (TLS verification enabled). No proxy.
 */
export function directFetchAdapter(
  id: string,
  opts: { defaultTimeoutMs?: number; extraHeaders?: Record<string, string> } = {},
): TransportAdapter {
  let totalCalls = 0;
  let totalFailures = 0;
  let consecutiveFailures = 0;
  let latencySumMs = 0;
  let latencySamples = 0;
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;
  const circuitOpenUntilMsRef = { current: null as number | null };

  function recordFailure() {
    totalFailures += 1;
    consecutiveFailures += 1;
    lastFailureAt = Date.now();
  }
  function recordSuccess(latencyMs: number) {
    totalCalls += 1;
    consecutiveFailures = 0;
    lastSuccessAt = Date.now();
    latencySumMs += latencyMs;
    latencySamples += 1;
  }

  return {
    id,
    role: "primary",
    label: `Direct: ${id}`,
    async fetch(url, opts2) {
      const timeoutMs = opts2?.timeoutMs ?? opts.defaultTimeoutMs ?? 15_000;
      if (circuitOpenUntilMsRef.current !== null && Date.now() < circuitOpenUntilMsRef.current) {
        throw new TransportError("NETWORK", `circuit open for ${id}`, {
          retryable: true,
        });
      }
      const startedAt = Date.now();
      try {
        const res = await fetch(url, {
          headers: { ...DEFAULT_HEADERS, ...(opts.extraHeaders ?? {}) },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const elapsed = Date.now() - startedAt;
        if (!res.ok) {
          recordFailure();
          const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
          const code =
            res.status >= 500 || res.status === 408 || res.status === 429
              ? "STATUS_5XX"
              : "STATUS_4XX";
          throw new TransportError(code, `HTTP ${res.status} from ${url}`, {
            status: res.status,
            retryable,
          });
        }
        const text = await res.text();
        recordSuccess(elapsed);
        return {
          body: text,
          status: res.status,
          contentType: res.headers.get("content-type"),
        };
      } catch (err) {
        if (err instanceof TransportError) throw err;
        recordFailure();
        const message = err instanceof Error ? err.message : String(err);
        const code = message.toLowerCase().includes("aborted") || message.toLowerCase().includes("timeout")
          ? "TIMEOUT"
          : "NETWORK";
        throw new TransportError(code, message, { retryable: true, cause: err });
      }
    },
    stats() {
      return {
        id,
        role: "primary",
        label: `Direct: ${id}`,
        totalCalls,
        totalFailures,
        consecutiveFailures,
        averageLatencyMs: latencySamples ? latencySumMs / latencySamples : null,
        lastSuccessAt,
        lastFailureAt,
        circuitOpenUntilMs: circuitOpenUntilMsRef.current,
      };
    },
  };
}

/**
 * Regional relay adapter. Talks to a self-hosted relay endpoint deployed in
 * Ethiopia that fetches the upstream URL on our behalf and returns the raw
 * response body. Wire format:
 *
 *   GET {relayBaseUrl}/{provider}/{reference}
 *   Headers:
 *     x-relay-key: {key}
 *
 * Response: 200 with the raw upstream body, 401 on bad key, 502/504 when the
 * upstream is unreachable from the relay host. The relay itself never logs
 * full bodies.
 */
export function relayFetchAdapter(
  id: string,
  opts: {
    relayBaseUrl: string;
    key: string;
    providerSlug: string;
    defaultTimeoutMs?: number;
  },
): TransportAdapter {
  const base = opts.relayBaseUrl.replace(/\/+$/, "");
  const logv = log.child({ module: "transport-relay" });
  let totalCalls = 0;
  let totalFailures = 0;
  let consecutiveFailures = 0;
  let latencySumMs = 0;
  let latencySamples = 0;
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;
  const circuitOpenUntilMsRef = { current: null as number | null };

  function recordFailure() {
    totalFailures += 1;
    consecutiveFailures += 1;
    lastFailureAt = Date.now();
  }
  function recordSuccess(latencyMs: number) {
    totalCalls += 1;
    consecutiveFailures = 0;
    lastSuccessAt = Date.now();
    latencySumMs += latencyMs;
    latencySamples += 1;
  }

  return {
    id,
    role: "regional",
    label: `Relay: ${id}`,
    async fetch(referenceOrUrl, opts2) {
      const timeoutMs = opts2?.timeoutMs ?? opts.defaultTimeoutMs ?? 18_000;
      if (circuitOpenUntilMsRef.current !== null && Date.now() < circuitOpenUntilMsRef.current) {
        throw new TransportError("NETWORK", `circuit open for ${id}`, {
          retryable: true,
        });
      }
      // Encode the upstream URL as base64url (not percent-encoded). The
      // relay lives behind reverse proxies (Plesk Nginx, etc.) that block
      // any decoded path containing `%2F`, so percent-encoded URLs like
      // `https%3A%2F%2F...%2F...` get rejected at the edge. base64url only
      // uses [A-Za-z0-9-_] + `=` padding and survives every common proxy
      // path filter.
      const encodedRef = Buffer.from(referenceOrUrl, "utf8").toString("base64url");
      const url = `${base}/${encodeURIComponent(opts.providerSlug)}/${encodedRef}`;
      // Log the *exact* outbound URL the worker is about to send. The pool's
      // `[transport-pool] url=…` line shows the upstream argument, not what
      // the adapter fetched — this line is the source of truth for "did the
      // worker actually call the relay?". Correlate `outbound=` with the
      // Plesk relay's access log by the base64url suffix.
      let upstreamHost = "?";
      try {
        upstreamHost = new URL(referenceOrUrl).host;
      } catch {
        // non-URL upstream arg — just leave upstreamHost as "?".
      }
      logv.info(
        `[transport-relay] adapter=${id} outbound=${url} ` +
          `provider=${opts.providerSlug} upstreamHost=${upstreamHost} ` +
          `key=${opts.key ? "set" : "missing"}`,
      );
      const startedAt = Date.now();
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: {
            ...DEFAULT_HEADERS,
            "x-relay-key": opts.key,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const elapsed = Date.now() - startedAt;
        if (res.status === 401 || res.status === 403) {
          recordFailure();
          throw new TransportError("RELAY_AUTH", `relay rejected key (${res.status})`, {
            status: res.status,
            retryable: false,
          });
        }
        if (res.status === 502 || res.status === 504 || res.status === 503) {
          recordFailure();
          throw new TransportError("STATUS_5XX", `relay upstream unreachable (${res.status})`, {
            status: res.status,
            retryable: true,
          });
        }
        if (!res.ok) {
          recordFailure();
          const text = await res.text().catch(() => "");
          throw new TransportError(
            "RELAY_BAD_RESPONSE",
            `relay HTTP ${res.status}: ${text.slice(0, 200)}`,
            {
              status: res.status,
              retryable: res.status >= 500,
            },
          );
        }
        const body = await res.text();
        // Relays echo the upstream status code in `x-upstream-status`. If
        // the upstream returned 404 the relay returns 200 with body=""; we
        // convert that into a permanent failure.
        const upstreamStatus = Number(res.headers.get("x-upstream-status") ?? "200");
        if (upstreamStatus === 404 || upstreamStatus === 410) {
          recordFailure();
          throw new TransportError("STATUS_4XX", `upstream HTTP ${upstreamStatus}`, {
            status: upstreamStatus,
            retryable: false,
          });
        }
        if (upstreamStatus >= 500 || upstreamStatus === 408 || upstreamStatus === 429) {
          recordFailure();
          throw new TransportError("STATUS_5XX", `upstream HTTP ${upstreamStatus}`, {
            status: upstreamStatus,
            retryable: true,
          });
        }
        recordSuccess(elapsed);
        return {
          body,
          status: upstreamStatus,
          contentType: res.headers.get("content-type"),
        };
      } catch (err) {
        if (err instanceof TransportError) throw err;
        recordFailure();
        const message = err instanceof Error ? err.message : String(err);
        const code = message.toLowerCase().includes("aborted") || message.toLowerCase().includes("timeout")
          ? "TIMEOUT"
          : "NETWORK";
        throw new TransportError(code, `relay fetch failed: ${message}`, {
          retryable: true,
          cause: err,
        });
      }
    },
    stats() {
      return {
        id,
        role: "regional",
        label: `Relay: ${id}`,
        totalCalls,
        totalFailures,
        consecutiveFailures,
        averageLatencyMs: latencySamples ? latencySumMs / latencySamples : null,
        lastSuccessAt,
        lastFailureAt,
        circuitOpenUntilMs: circuitOpenUntilMsRef.current,
      };
    },
  };
}

/**
 * Open the circuit on an adapter for `cooldownMs`. Called by the pool after
 * `failureThreshold` consecutive failures. The adapter enforces it on its
 * next call.
 */
export function tripAdapterCircuit(
  adapter: TransportAdapter,
  cooldownMs: number,
): void {
  // Cast through unknown so we can mutate the internal `circuitOpenUntilMs`
  // set up by the two adapter factories. We keep this helper rather than
  // exposing the field on the public interface.
  const internal = adapter as unknown as {
    circuitOpenUntilMsRef?: { current: number | null };
  };
  if (internal.circuitOpenUntilMsRef) {
    internal.circuitOpenUntilMsRef.current = Date.now() + cooldownMs;
  }
}
