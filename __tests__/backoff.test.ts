/**
 * Backoff schedule tests — the only timer-driven retry we keep. This is
 * intra-process bookkeeping after a failed job, NOT cross-process polling.
 */
import { describe, expect, it } from "vitest";
import { backoffMs } from "../src/workers/backoff.js";

describe("backoffMs", () => {
  it("starts at the default 5s for the first retry", () => {
    expect(backoffMs(1)).toBe(5_000);
  });
  it("doubles each attempt", () => {
    expect(backoffMs(2)).toBe(10_000);
    expect(backoffMs(3)).toBe(20_000);
    expect(backoffMs(4)).toBe(40_000);
  });
  it("caps at 5 minutes", () => {
    expect(backoffMs(20)).toBe(5 * 60_000);
  });
  it("is stable across many attempts", () => {
    for (let i = 1; i <= 50; i++) {
      const ms = backoffMs(i);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(5 * 60_000);
    }
  });
});