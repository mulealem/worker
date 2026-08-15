/**
 * Shared parser helpers.
 *
 * Each bank parser is a pure function: given its native input (HTML string,
 * JSON, PDF text, OCR text, …) and a `source` label, return a `ReceiptData`.
 * If parsing fails, return null. The dispatcher in `verify.ts` decides what
 * to do with the null (e.g. fall through to manual review).
 */

import type { ReceiptData } from "../types.js";

/** Strip everything except digits and dots, then parse. */
export function parseAmount(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/,/g, "").replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Try a list of ISO date patterns; return the first match (ISO) or the raw text. */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Patterns cover the formats the 6 banks emit. Order matters — the more
  // specific patterns go first.
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    // CBE PDF: "5/28/2026, 2:54:58 PM"
    [/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i, (m) => {
      const [, mo, d, y, h, mi, s, ap] = m;
      const iso = new Date(`${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:${s}`);
      return Number.isNaN(iso.getTime()) ? trimmed : iso.toISOString();
    }],
    // Dashen: "May 28, 2026, 2:54:58 PM"
    [/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i, (m) => {
      const d = new Date(`${m[1]} ${m[2]}, ${m[3]} ${m[4]}:${m[5]}:${m[6]} ${m[7]}`);
      return Number.isNaN(d.getTime()) ? trimmed : d.toISOString();
    }],
    // Telebirr receipt: "28-05-2026 14:54:58"
    [/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/, (m) => {
      const iso = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}`);
      return Number.isNaN(iso.getTime()) ? trimmed : iso.toISOString();
    }],
    // Zemen: "28-May-2026"
    [/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/, (m) => {
      const d = new Date(`${m[2]} ${m[1]}, ${m[3]}`);
      return Number.isNaN(d.getTime()) ? trimmed : d.toISOString();
    }],
  ];
  for (const [re, fn] of patterns) {
    const m = trimmed.match(re);
    if (m) return fn(m);
  }
  return trimmed;
}

/** Common empty `ReceiptData` for a given provider/source. */
export function emptyReceipt(
  provider: ReceiptData["provider"],
  sourceUrl: string,
): ReceiptData {
  return {
    provider,
    referenceId: "",
    amount: null,
    currency: "ETB",
    paymentDate: null,
    payerName: null,
    payerAccount: null,
    payerPhone: null,
    receiverName: null,
    receiverAccount: null,
    receiverBank: null,
    serviceFee: null,
    vat: null,
    totalPaid: null,
    transactionType: null,
    paymentMode: null,
    paymentReason: null,
    paymentChannel: null,
    narrative: null,
    sourceUrl,
  };
}
