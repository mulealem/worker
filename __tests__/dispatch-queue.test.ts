/**
 * Tests for the in-memory dispatch queue.
 *
 * Goal: pin the contract that makes the push-only architecture safe:
 *   - Duplicate pushes are deduped (no double-execution).
 *   - The executor wakes only when work arrives (no busy-wait).
 *   - Retry timers correctly release in-flight slots before re-enqueueing.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  _resetForTests,
  _dedupeKey,
  enqueueLocal,
  inFlightCount,
  markDone,
  nextAvailable,
  pendingCount,
  scheduleRetry,
  takeNext,
  type DispatchJob,
} from "../src/workers/dispatch-queue.js";

function makeJob(overrides: Partial<DispatchJob> = {}): DispatchJob {
  return {
    jobId: "job-1",
    paymentId: "pay-1",
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

beforeEach(() => {
  _resetForTests();
});

describe("dedupeKey", () => {
  it("uses idempotencyKey when present", () => {
    expect(_dedupeKey(makeJob({ idempotencyKey: "boot:abc" }))).toBe("boot:abc");
  });
  it("returns null when no idempotencyKey (local retries must re-execute)", () => {
    expect(_dedupeKey(makeJob({ jobId: "job-42" }))).toBeNull();
  });
});

describe("enqueueLocal", () => {
  it("accepts a fresh job and reports deduped=false", () => {
    const r = enqueueLocal(makeJob());
    expect(r).toEqual({ accepted: true, deduped: false });
    expect(pendingCount()).toBe(1);
  });

  it("dedupes a duplicate push by idempotencyKey", () => {
    enqueueLocal(makeJob({ idempotencyKey: "k1" }));
    const r = enqueueLocal(makeJob({ idempotencyKey: "k1" }));
    expect(r.deduped).toBe(true);
    expect(pendingCount()).toBe(1);
  });

  it("does NOT dedupe by jobId alone (local retries must re-execute)", () => {
    enqueueLocal(makeJob({ jobId: "j-1" }));
    const r = enqueueLocal(makeJob({ jobId: "j-1" }));
    expect(r.deduped).toBe(false);
    expect(pendingCount()).toBe(2);
  });

  it("treats different idempotencyKeys as distinct jobs", () => {
    enqueueLocal(makeJob({ idempotencyKey: "k1", jobId: "j-1" }));
    enqueueLocal(makeJob({ idempotencyKey: "k2", jobId: "j-2" }));
    expect(pendingCount()).toBe(2);
  });
});

describe("takeNext + markDone", () => {
  it("pops the next job and marks it in-flight", () => {
    enqueueLocal(makeJob({ jobId: "a" }));
    enqueueLocal(makeJob({ jobId: "b" }));
    const first = takeNext();
    expect(first?.jobId).toBe("a");
    expect(inFlightCount()).toBe(1);
    expect(pendingCount()).toBe(1);
    markDone("a");
    expect(inFlightCount()).toBe(0);
  });

  it("returns null when the queue is empty", () => {
    expect(takeNext()).toBeNull();
  });
});

describe("nextAvailable", () => {
  it("resolves immediately if work is already queued", async () => {
    enqueueLocal(makeJob());
    await expect(nextAvailable()).resolves.toBeUndefined();
  });

  it("wakes the executor when a push arrives", async () => {
    const waiter = nextAvailable();
    // Simulate the dispatch router pushing a job.
    setTimeout(() => enqueueLocal(makeJob({ jobId: "wake" })), 5);
    const start = Date.now();
    await waiter;
    expect(Date.now() - start).toBeLessThan(500);
    expect(pendingCount()).toBe(1);
  });
});

describe("scheduleRetry", () => {
  it("re-enqueues the job after the timer fires", async () => {
    const job = makeJob({ jobId: "retry-1", attempts: 1 });
    enqueueLocal(job);
    takeNext();
    expect(inFlightCount()).toBe(1);

    scheduleRetry({ ...job, attempts: 2 }, 10);
    await new Promise((r) => setTimeout(r, 50));
    expect(pendingCount()).toBe(1);
    // inFlight must be released before the re-enqueue, otherwise the
    // executor would never re-execute it.
    expect(inFlightCount()).toBe(0);
  });
});