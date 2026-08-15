/**
 * Universal verifier — dispatches by reference shape and provider-specific
 * suffix rules. Used by `POST /api/v1/verify` and (optionally) by future
 * admin tools.
 *
 * Dispatch table:
 *
 *   starts with `http(s)://`            → detectProvider(url) flow
 *   `apps.cbe.com.et:100/?id=FT…{s8}`  → legacy CBE (not supported here —
 *                                          we explicitly refuse per project
 *                                          policy)
 *   `mbreciept.cbe.com.et/{token}`     → CBE new-token API
 *   `mb.cbe.com.et/.../transaction-detail/{token}`
 *                                         → CBE new-token API
 *   `FT…` + 8-digit suffix              → CBE new-token (legacy URL form)
 *   `FT…` + 5-digit suffix              → Bank of Abyssinia JSON API
 *   16-digit reference                  → Dashen
 *   10-char alphanumeric + phone        → CBE Birr (phone required)
 *   10-char alphanumeric, no phone      → Telebirr
 *   everything else                     → Telebirr (best-effort fallback)
 */

import { fetchCbeApi, fetchPdf } from "./fetcher.js";
import { parseCbeFromApiJson } from "./parsers/cbe.js";
import { parseBoaFromUrl } from "./parsers/boa.js";
import { parseDashenFromPdfBuffer } from "./parsers/dashen.js";
import { parseTelebirrFromUrl } from "./parsers/telebirr.js";
import type { Provider, ReceiptData } from "./types.js";
import { log } from "..\/log.js";

const logv = log.child({ module: "verifier.universal" });

export interface SmartVerifyInput {
  /** Receipt reference, full URL, or transaction id. */
  reference: string;
  /** Optional suffix appended to the reference by some banks. */
  suffix?: string;
  /** Phone number (required for CBE Birr). */
  phoneNumber?: string | null;
}

export type SmartVerifyOutcome =
  | { ok: true; provider: Provider; data: ReceiptData }
  | { ok: false; provider: Provider | null; status: number | null; error: string };

export async function runSmartVerify(input: SmartVerifyInput): Promise<SmartVerifyOutcome> {
  const reference = input.reference.trim();
  const suffix = (input.suffix ?? "").trim();
  logv.info(`runSmartVerify reference=${reference.slice(0, 40)}… suffix=${suffix}`);

  // 1. Full URL → route by host.
  if (/^https?:\/\//i.test(reference)) {
    try {
      const url = new URL(reference);
      const host = url.hostname;
      if (host === "mbreciept.cbe.com.et" || host === "mb.cbe.com.et") {
        const { json, raw } = await fetchCbeApi(reference);
        const data = parseCbeFromApiJson(json, reference, raw);
        data.extractionMethod = "smart-cbe-api";
        return { ok: true, provider: "cbe", data };
      }
      if (host === "receipt.dashensuperapp.com") {
        const buf = await fetchPdf(reference, "dashen");
        const data = await parseDashenFromPdfBuffer(buf, reference);
        data.extractionMethod = "smart-dashen";
        return { ok: true, provider: "dashen", data };
      }
      if (host === "cs.bankofabyssinia.com") {
        const data = await parseBoaFromUrl(reference);
        data.extractionMethod = "smart-boa";
        return { ok: true, provider: "boa", data };
      }
      if (host === "transactioninfo.ethiotelecom.et") {
        const data = await parseTelebirrFromUrl(reference);
        data.extractionMethod = "smart-telebirr";
        return { ok: true, provider: "telebirr", data };
      }
      return {
        ok: false,
        provider: null,
        status: null,
        error: `Host ${host} is not supported.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number | null }).status ?? null;
      return { ok: false, provider: null, status, error: msg };
    }
  }

  // 2. Bare reference — dispatch by shape.

  // 2a. CBE new-token form: 15-40 char alphanumeric token.
  if (/^[A-Za-z0-9_-]{15,40}$/.test(reference) && !suffix) {
    const url = `https://mbreciept.cbe.com.et/${encodeURIComponent(reference)}`;
    try {
      const { json, raw } = await fetchCbeApi(url);
      const data = parseCbeFromApiJson(json, url, raw);
      data.extractionMethod = "smart-cbe-token";
      return { ok: true, provider: "cbe", data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number | null }).status ?? null;
      return { ok: false, provider: "cbe", status, error: msg };
    }
  }

  // 2b. FT + suffix.
  if (/^FT[A-Za-z0-9]{6,12}$/.test(reference) && suffix) {
    if (/^\d{8}$/.test(suffix)) {
      // CBE — try as `FT…` + 8-digit suffix via mbreciept.cbe.com.et.
      const token = `${reference}${suffix}`;
      const url = `https://mbreciept.cbe.com.et/${encodeURIComponent(token)}`;
      try {
        const { json, raw } = await fetchCbeApi(url);
        const data = parseCbeFromApiJson(json, url, raw);
        data.extractionMethod = "smart-cbe-ft-suffix";
        return { ok: true, provider: "cbe", data };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = (err as { status?: number | null }).status ?? null;
        return { ok: false, provider: "cbe", status, error: msg };
      }
    }
    if (/^\d{5}$/.test(suffix)) {
      // Bank of Abyssinia
      const slipUrl = `https://cs.bankofabyssinia.com/slip/?trx=${encodeURIComponent(reference)}${encodeURIComponent(suffix)}`;
      try {
        const data = await parseBoaFromUrl(slipUrl);
        data.extractionMethod = "smart-boa-suffix";
        return { ok: true, provider: "boa", data };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = (err as { status?: number | null }).status ?? null;
        return { ok: false, provider: "boa", status, error: msg };
      }
    }
  }

  // 2c. 16-digit reference → Dashen.
  if (/^\d{16}$/.test(reference)) {
    const url = `https://receipt.dashensuperapp.com/receipt/${reference}`;
    try {
      const buf = await fetchPdf(url, "dashen");
      const data = await parseDashenFromPdfBuffer(buf, url);
      data.extractionMethod = "smart-dashen-16";
      return { ok: true, provider: "dashen", data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number | null }).status ?? null;
      return { ok: false, provider: "dashen", status, error: msg };
    }
  }

  // 2d. 10-char alphanumeric + phone → CBE Birr (else Telebirr).
  if (/^[A-Za-z0-9]{10}$/.test(reference)) {
    if (input.phoneNumber) {
      const phone = input.phoneNumber.replace(/\s+/g, "");
      if (/^251\d{9}$/.test(phone)) {
        const url = `https://cbepay1.cbe.com.et/aureceipt?TID=${encodeURIComponent(reference)}&PH=${encodeURIComponent(phone)}`;
        try {
          const buf = await fetchPdf(url, "cbe-birr");
          const { parseCbeBirrFromPdfBuffer } = await import("./parsers/cbe-birr.js");
          const data = await parseCbeBirrFromPdfBuffer(buf, url);
          data.extractionMethod = "smart-cbe-birr";
          return { ok: true, provider: "cbe-birr", data };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const status = (err as { status?: number | null }).status ?? null;
          return { ok: false, provider: "cbe-birr", status, error: msg };
        }
      }
    }
    // Fallback: Telebirr.
    try {
      const url = `https://transactioninfo.ethiotelecom.et/receipt/${reference}`;
      const data = await parseTelebirrFromUrl(url);
      data.extractionMethod = "smart-telebirr-10";
      return { ok: true, provider: "telebirr", data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number | null }).status ?? null;
      return { ok: false, provider: "telebirr", status, error: msg };
    }
  }

  // 2e. Catch-all: best-effort Telebirr.
  try {
    const url = `https://transactioninfo.ethiotelecom.et/receipt/${encodeURIComponent(reference)}`;
    const data = await parseTelebirrFromUrl(url);
    data.extractionMethod = "smart-telebirr-fallback";
    return { ok: true, provider: "telebirr", data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, provider: "telebirr", status: null, error: msg };
  }
}
