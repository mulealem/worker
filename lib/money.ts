/**
 * Currency helpers. ETB has 2 decimal places; we store amounts as **minor
 * units** (1 ETB = 100) and convert at the edges. `Float` math loses money;
 * `Int` math doesn't.
 *
 * `lib/money.ts` is the only place we touch currency conversion — keep all
 * the weirdness here.
 */

/** ETB has 100 minor units per major. */
export const MINOR_PER_MAJOR = 100;

/**
 * Convert a major-unit float (e.g. `12.34`) into integer minor units
 * (`1234`). Returns `null` if the input can't be safely represented.
 */
export function toMinor(amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  const minor = Math.round(amount * MINOR_PER_MAJOR);
  if (!Number.isFinite(minor)) return null;
  return minor;
}

/** Convert integer minor units back to a major-unit float. */
export function fromMinor(minor: number): number {
  return minor / MINOR_PER_MAJOR;
}

/**
 * `a === b` within `toleranceMinor` minor units (default: 1 ETB). Used by
 * the verifier to absorb small fees/rounding without trusting the parser's
 * exact number.
 */
export function amountsMatchMinor(
  aMinor: number,
  bMinor: number,
  toleranceMinor = MINOR_PER_MAJOR,
): boolean {
  return Math.abs(aMinor - bMinor) <= toleranceMinor;
}
