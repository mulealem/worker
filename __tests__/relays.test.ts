/**
 * Shared relay pool tests: config parsing (RELAYS / RELAYS_FILE shapes),
 * the /relay/{base64url} wire format, round-robin distribution across
 * relays, failover on retryable failures, and per-relay circuit breaking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRelayEntry,
  parseRelaysEnv,
  parseRelaysJson,
} from "../lib/verifier/relays.js";
import {
  relayBalancerAdapter,
  _resetRelaysForTests,
  getSharedRelayBalancer,
} from "../lib/verifier/relays.js";
import {
  relayFetchAdapter,
  TransportError,
} from "../lib/verifier/transport.js";
import { TransportPool } from "../lib/verifier/pool.js";

// ---------- config parsing ----------

describe("parseRelayEntry", () => {
  it("splits url|key on the first pipe", () => {
    expect(parseRelayEntry("https://r1.test|k|1", null)).toEqual({
      url: "https://r1.test",
      key: "k|1",
    });
  });

  it("falls back to the global key for bare urls", () => {
    expect(parseRelayEntry("https://r1.test/", "shared")).toEqual({
      url: "https://r1.test",
      key: "shared",
    });
  });

  it("rejects a bare url with no global key", () => {
    expect(parseRelayEntry("https://r1.test", null)).toHaveProperty("error");
  });

  it("rejects non-http(s) or malformed urls", () => {
    expect(parseRelayEntry("ftp://r1.test|k", null)).toHaveProperty("error");
    expect(parseRelayEntry("not a url|k", null)).toHaveProperty("error");
  });
});

describe("parseRelaysEnv", () => {
  it("splits on commas and newlines and drops empties", () => {
    const { relays, errors } = parseRelaysEnv(
      "https://r1.test|k1,\nhttps://r2.test|k2 ,,",
      null,
    );
    expect(errors).toEqual([]);
    expect(relays).toEqual([
      { url: "https://r1.test", key: "k1" },
      { url: "https://r2.test", key: "k2" },
    ]);
  });

  it("collects per-entry errors without dropping good entries", () => {
    const { relays, errors } = parseRelaysEnv("https://r1.test|k1,bogus", null);
    expect(relays).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});

describe("parseRelaysJson", () => {
  it("accepts a top-level array of {url, key} objects", () => {
    const { relays, errors } = parseRelaysJson(
      '[{"url":"https://r1.test","key":"k1"}]',
      null,
    );
    expect(errors).toEqual([]);
    expect(relays).toEqual([{ url: "https://r1.test", key: "k1" }]);
  });

  it("accepts the {relays: [...]} wrapper and string entries", () => {
    const { relays, errors } = parseRelaysJson(
      '{"relays":["https://r1.test|k1",{"url":"https://r2.test"}]}',
      "shared",
    );
    expect(errors).toEqual([]);
    expect(relays).toEqual([
      { url: "https://r1.test", key: "k1" },
      { url: "https://r2.test", key: "shared" },
    ]);
  });

  it("reports invalid JSON and unsupported shapes as errors", () => {
    expect(parseRelaysJson("{nope", null).errors.length).toBeGreaterThan(0);
    expect(parseRelaysJson('{"relays": 4}', null).errors.length).toBeGreaterThan(0);
  });
});

// ---------- adapter + balancer behaviour ----------

type FetchCall = { url: string; key: string | null; host: string };

function okResponse(body = "upstream-body") {
  return {
    ok: true,
    status: 200,
    text: async () => body,
    headers: { get: () => null },
  };
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<unknown>) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const s = String(url);
    calls.push({
      url: s,
      key: (init?.headers as Record<string, string> | undefined)?.["x-relay-key"] ?? null,
      host: new URL(s).host,
    });
    return impl(s, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const UPSTREAM = "https://mbreciept.cbe.com.et/api/receipt?ref=ABC123";

function relayAdapterFor(host: string) {
  return relayFetchAdapter(`relay-${host}`, {
    relayBaseUrl: `http://${host}`,
    key: `key-${host}`,
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  _resetRelaysForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _resetRelaysForTests();
});

describe("relayFetchAdapter wire format", () => {
  it("builds {base}/relay/{base64url} and sends x-relay-key", async () => {
    const calls = stubFetch(async () => okResponse());
    const adapter = relayAdapterFor("r1.test");
    await adapter.fetch(UPSTREAM);
    expect(calls).toHaveLength(1);
    const expected =
      "http://r1.test/relay/" + Buffer.from(UPSTREAM, "utf8").toString("base64url");
    expect(calls[0].url).toBe(expected);
    expect(calls[0].key).toBe("key-r1.test");
  });

  it("treats a relay-level 404 (stale relay script) as retryable", async () => {
    stubFetch(async () => ({
      ok: false,
      status: 404,
      text: async () => "Not Found",
      headers: { get: () => null },
    }));
    const adapter = relayAdapterFor("r1.test");
    const err = await adapter.fetch(UPSTREAM).catch((e) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.retryable).toBe(true);
  });
});

describe("relayBalancerAdapter round-robin + failover", () => {
  it("rotates consecutive calls across all relays", async () => {
    const calls = stubFetch(async () => okResponse());
    const balancer = relayBalancerAdapter([
      relayAdapterFor("r1.test"),
      relayAdapterFor("r2.test"),
      relayAdapterFor("r3.test"),
    ]);
    await balancer.fetch(UPSTREAM);
    await balancer.fetch(UPSTREAM);
    await balancer.fetch(UPSTREAM);
    await balancer.fetch(UPSTREAM);
    expect(calls.map((c) => c.host)).toEqual([
      "r1.test",
      "r2.test",
      "r3.test",
      "r1.test",
    ]);
  });

  it("failover: after a failed relay the next call picks the next healthy one", async () => {
    const calls = stubFetch(async (url) => {
      if (new URL(url).host === "r1.test") {
        throw new Error("aborted");
      }
      return okResponse();
    });
    const balancer = relayBalancerAdapter([
      relayAdapterFor("r1.test"),
      relayAdapterFor("r2.test"),
    ]);
    const err = await balancer.fetch(UPSTREAM).catch((e) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.retryable).toBe(true);
    const result = await balancer.fetch(UPSTREAM);
    expect(result.status).toBe(200);
    expect(calls.map((c) => c.host)).toEqual(["r1.test", "r2.test"]);
  });

  it("skips a relay whose circuit is open", async () => {
    const calls = stubFetch(async (url) => {
      if (new URL(url).host === "r1.test") throw new Error("aborted");
      return okResponse();
    });
    const balancer = relayBalancerAdapter(
      [relayAdapterFor("r1.test"), relayAdapterFor("r2.test")],
      { failureThreshold: 1, cooldownMs: 60_000 },
    );
    await balancer.fetch(UPSTREAM).catch(() => {}); // trips r1 (threshold 1)
    await balancer.fetch(UPSTREAM);
    await balancer.fetch(UPSTREAM);
    expect(calls.map((c) => c.host)).toEqual(["r1.test", "r2.test", "r2.test"]);
  });

  it("throws a retryable error when every circuit is open", async () => {
    stubFetch(async () => {
      throw new Error("aborted");
    });
    const balancer = relayBalancerAdapter(
      [relayAdapterFor("r1.test"), relayAdapterFor("r2.test")],
      { failureThreshold: 1, cooldownMs: 60_000 },
    );
    await balancer.fetch(UPSTREAM).catch(() => {});
    await balancer.fetch(UPSTREAM).catch(() => {});
    const err = await balancer.fetch(UPSTREAM).catch((e) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("no healthy relays");
  });
});

describe("TransportPool with the shared balancer", () => {
  it("spreads retries across distinct relays instead of hammering one", async () => {
    const calls = stubFetch(async (url) => {
      if (new URL(url).host === "r1.test") throw new Error("aborted");
      return okResponse();
    });
    const balancer = relayBalancerAdapter([
      relayAdapterFor("r1.test"),
      relayAdapterFor("r2.test"),
      relayAdapterFor("r3.test"),
    ]);
    const pool = new TransportPool([balancer], {
      maxAttempts: 3,
      retryDelayMs: 1,
      failureThreshold: Number.POSITIVE_INFINITY,
    });
    const outcome = await pool.fetch(UPSTREAM);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.attempts).toBe(2);
      expect(outcome.adapterId).toBe("relay-pool");
    }
    // One attempt per relay: r1 (fail) → r2 (ok). Never two attempts on r1.
    expect(calls.map((c) => c.host)).toEqual(["r1.test", "r2.test"]);
  });

  it("does NOT trip the balancer's circuit (failureThresholdOverride)", async () => {
    stubFetch(async (url) => {
      if (new URL(url).host === "r1.test") throw new Error("aborted");
      return okResponse();
    });
    const balancer = relayBalancerAdapter([
      relayAdapterFor("r1.test"),
      relayAdapterFor("r2.test"),
    ]);
    expect(balancer.failureThresholdOverride).toBe(Number.POSITIVE_INFINITY);
    const pool = new TransportPool([balancer], {
      maxAttempts: 1,
      retryDelayMs: 1,
      failureThreshold: 1,
      cooldownMs: 60_000,
    });
    // Two consecutive all-failure pool calls must not circuit-open the
    // balancer adapter itself — only per-relay breakers (threshold default
    // 4) may trip, and r1 recovers here so nothing trips.
    await pool.fetch(UPSTREAM);
    const outcome = await pool.fetch(UPSTREAM);
    expect(outcome.kind).toBe("ok");
  });
});

// ---------- shared singleton ----------

describe("getSharedRelayBalancer", () => {
  const ENV_KEYS = ["RELAYS", "RELAYS_FILE", "RELAY_SHARED_KEY"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("builds one balancer from RELAYS and caches it", () => {
    process.env.RELAYS = "https://r1.test|k1,https://r2.test|k2";
    const first = getSharedRelayBalancer();
    expect(first).not.toBeNull();
    expect(first!.label).toBe("Relay pool (2 relays)");
    expect(getSharedRelayBalancer()).toBe(first);
  });

  it("returns null when nothing is configured (direct-only degradation)", () => {
    expect(getSharedRelayBalancer()).toBeNull();
  });
});
