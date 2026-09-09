/**
 * `verify.ts` — the verifier entry point.
 *
 * Given a Payment (with its Order, Project, and bankAccount), decide whether
 * to auto-approve. Routes on `receiptType`:
 *
 *   IMAGE / SMS_SCREENSHOT
 *     1. Read file from `uploads/{receiptPath}`
 *     2. Scan QR code → dispatching to provider-specific URL flow
 *     3. If no QR: OCR the bytes (tesseract.js)
 *     4. If OCR text contains a known-bank URL → URL flow
 *     5. Else if provider is Telebirr → screenshot parser
 *     6. Else: pull labeled reference numbers out of the OCR text and run
 *        them through the transaction-number flow (all providers)
 *     7. Else → SKIPPED
 *
 *   SMS_TEXT
 *     1. `receiptPath` is the raw text
 *     2. findBankUrl(text) → URL flow
 *     3. If no URL → SKIPPED
 *
 *   TRANSACTION_NUMBER
 *     → SKIPPED (nothing to fetch or OCR)
 *
 * On success returns `VERIFIED` with a `ReceiptData`; on extraction failure
 * returns `UNVERIFIED`; on inputs we can't auto-verify returns `SKIPPED`; on
 * any thrown error returns `ERROR` with a reason.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import type { ReceiptType } from "./capabilities.js";
import type { BankType } from "./bank-type.js";

export interface Order {
  id: string;
  amountMinor: number;
  amount: number;
  currency: string;
  description: string;
  metadata: string | null;
}

export interface BankAccount {
  id: string;
  type: BankType;
  accountNumber: string;
  phoneNumber: string | null;
}

export type Payment = {
  id: string;
  receiptPath: string;
  receiptType: ReceiptType;
};

export type Project = {
  id: string;
  apiKey: string;
  callbackUrl: string;
};
import { findBankUrl, detectProvider } from "./detector.js";
import { fetchCbeApi, fetchHtml, fetchPdf, fetchMpesaApi } from "./fetcher.js";
import { extractText, detectProviderFromText } from "./ocr.js";
import { extractQrPayloads } from "./qr.js";
import { parseCbeFromApiJson } from "./parsers/cbe.js";
import { parseCbeBirrFromPdfBuffer, buildCbeBirrUrl } from "./parsers/cbe-birr.js";
import { parseDashenFromPdfBuffer } from "./parsers/dashen.js";
import { parseAwashFromHtml } from "./parsers/awash.js";
import { parseBoaFromUrl } from "./parsers/boa.js";
import { parseZemenFromPdfBuffer } from "./parsers/zemen.js";
import { parseTelebirrFromUrl } from "./parsers/telebirr.js";
import { parseTelebirrScreenshotFromText } from "./parsers/screenshot-telebirr.js";
import { parseMpesaFromPdfBuffer } from "./parsers/mpesa.js";
import type { ReceiptData, Provider, VerifyResult } from "./types.js";
import { amountsMatchMinor, fromMinor, toMinor } from "../money.js";
import { log } from "../log.js";
import { providerForBankType } from "./bank-type.js";

const logv = log.child({ module: "verifier" });

const UPLOAD_DIR = join(process.cwd(), "uploads");

/** Shape the verify entry point needs. Avoids pulling in the full Prisma type. */
export interface VerifiablePayment {
  id: string;
  receiptPath: string;
  receiptType: ReceiptType;
  order: Order;
  bankAccount: Pick<BankAccount, "type" | "accountNumber" | "phoneNumber"> | null;
  /** Override the phone number for CBE_BIRR lookups (usually the BankAccount's). */
  phoneNumber?: string | null;
  /** Override how receipt bytes are read. Defaults to the dashboard's local upload directory. Workers should pass an HTTP fetcher. */
  readReceiptBytes?: (receiptPath: string) => Promise<Buffer>;
}

async function readReceiptBytes(payment: VerifiablePayment): Promise<Buffer> {
  if (payment.readReceiptBytes) {
    return await payment.readReceiptBytes(payment.receiptPath);
  }
  return await readFile(join(UPLOAD_DIR, payment.receiptPath));
}

/**
 * URL flow — given a known-bank URL, fetch + parse using the right transport.
 */
async function verifyFromUrl(
  url: string,
  provider: Provider,
  options?: { phoneNumber?: string | null },
): Promise<ReceiptData | null> {
  logv.info(`verifyFromUrl provider=${provider} url=${url}`);
  const startedAt = Date.now();
  try {
    let data: ReceiptData | null = null;
    switch (provider) {
      case "cbe": {
        const host = new URL(url).hostname;
        if (host === "mbreciept.cbe.com.et") {
          const { json, raw } = await fetchCbeApi(url);
          data = parseCbeFromApiJson(json, url, raw);
          if (data) data.extractionMethod = "qr-cbe-api";
        } else {
          throw new Error(
            `CBE receipts can only be verified via the mbreciept.cbe.com.et API. ` +
              `Got host: ${host}. Make sure the QR code is from a CBE mobile-app receipt.`,
          );
        }
        break;
      }
      case "dashen": {
        const buf = await fetchPdf(url, provider);
        data = await parseDashenFromPdfBuffer(buf, url);
        break;
      }
      case "zemen": {
        const buf = await fetchPdf(url, provider);
        data = await parseZemenFromPdfBuffer(buf, url);
        break;
      }
      case "awash": {
        const html = await fetchHtml(url, provider);
        data = await parseAwashFromHtml(html, url);
        break;
      }
      case "boa": {
        data = await parseBoaFromUrl(url);
        break;
      }
      case "telebirr": {
        data = await parseTelebirrFromUrl(url);
        break;
      }
      case "cbe-birr": {
        const phoneNumber = options?.phoneNumber;
        if (!phoneNumber) {
          throw new Error(
            "CBE Birr receipts need a phone number. Enable CBE Birr on the project and ensure the phone number is captured.",
          );
        }
        const fetchUrl = url.includes("TID=") ? url : buildCbeBirrUrl(url, phoneNumber);
        const buf = await fetchPdf(fetchUrl, provider);
        data = await parseCbeBirrFromPdfBuffer(buf, fetchUrl);
        break;
      }
      case "mpesa": {
        // M-Pesa receipts aren't URLs — they're looked up by receipt number.
        // This branch is only hit if a URL accidentally matches; treat it as
        // a failure so callers fall back to the TRANSACTION_NUMBER flow.
        throw new Error(
          "M-Pesa receipts must be submitted as a transaction number, not a URL.",
        );
      }
    }
    if (data) {
      // Only set a generic fallback; callers (QR / OCR / SMS) may override.
      if (!data.extractionMethod) data.extractionMethod = `url-${provider}`;
    }
    const elapsedMs = Date.now() - startedAt;
    if (data && data.referenceId) {
      logv.info(
        `[verifier] verifyFromUrl OK provider=${provider} ` +
          `refId=${data.referenceId} amount=${data.amount ?? "<null>"} ` +
          `elapsedMs=${elapsedMs}`,
      );
    } else {
      logv.warn(
        `[verifier] verifyFromUrl no-ref provider=${provider} ` +
          `amount=${data?.amount ?? "<null>"} elapsedMs=${elapsedMs}`,
      );
    }
    return data;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : typeof err;
    logv.warn(
      `[verifier] verifyFromUrl FAIL provider=${provider} ` +
        `name=${name} message=${msg} elapsedMs=${elapsedMs}`,
    );
    throw err;
  }
}

/**
 * Image flow.
 *
 *   QR path (primary, ~50ms):
 *     - CBE mobile-app receipts always include a QR encoding the live
 *       receipt URL. Scan it → dispatch via verifyFromUrl when the URL is
 *       on the SSRF allowlist.
 *
 *   Tesseract OCR fallback:
 *     - URL in OCR text                 → fetch + parse (Dashen/Awash/BoA/Zemen)
 *     - Telebirr regex parser           → last-resort receipt extraction
 */
async function verifyFromImage(payment: VerifiablePayment): Promise<{
  data: ReceiptData | null;
  reason?: string;
}> {
  logv.info(`verifyFromImage start receiptPath=${payment.receiptPath}`);
  const bytes = await readReceiptBytes(payment);
  logv.info(`verifyFromImage loaded ${bytes.length} bytes`);

  // What we actually found vs. what failed, so the final SKIPPED reason can
  // tell the truth ("QR found but the bank lookup failed") instead of
  // claiming nothing was on the image.
  const found: string[] = [];

  // Primary path — QR code. CBE mobile-app receipts always include a QR
  // that encodes the live receipt URL. Scanning it directly is cheap and
  // deterministic. Other banks (Telebirr) skip straight to the OCR fallback.
  let qrPayloads: string[] = [];
  try {
    const qrStartedAt = Date.now();
    qrPayloads = await extractQrPayloads(bytes);
    logv.info(
      `[verifier] QR scan done in ${Date.now() - qrStartedAt}ms ` +
        `found=${qrPayloads.length}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logv.warn(`QR extraction failed: ${msg}`);
  }
  let lastQrLookupError: string | null = null;
  let lastQrUnsupportedError: string | null = null;
  for (const payload of qrPayloads) {
    logv.info(`QR payload: ${payload}`);
    try {
      const provider = detectProvider(payload);
      logv.info(
        `[verifier] QR dispatch: provider=${provider} url=${payload}`,
      );
      const data = await verifyFromUrl(payload, provider);
      if (data && !data.extractionMethod?.startsWith("qr-")) {
        data.extractionMethod = `qr-${provider}`;
      }
      return { data };
    } catch (urlErr) {
      const msg = urlErr instanceof Error ? urlErr.message : String(urlErr);
      if (
        urlErr instanceof Error &&
        urlErr.message.includes("is not supported")
      ) {
        lastQrUnsupportedError = msg;
        logv.warn(`QR payload is not a supported bank URL: ${msg}`);
      } else {
        lastQrLookupError = msg;
        logv.warn(`QR receipt lookup failed: ${msg}`);
      }
    }
  }
  if (qrPayloads.length > 0) {
    found.push("a QR code");
    if (lastQrLookupError) {
      found.push(`but its receipt lookup failed: ${lastQrLookupError}`);
    } else if (lastQrUnsupportedError) {
      found.push(
        `but it does not point at a supported bank receipt page (${lastQrUnsupportedError})`,
      );
    }
  }

  // Fallback: tesseract.js OCR. Used for Dashen / Awash / BoA / Zemen where
  // the receipt URL is opaque and can't be reconstructed from the ID.
  logv.info(`image path: falling back to tesseract OCR`);
  const ocrStartedAt = Date.now();
  let ocrText: string | null;
  try {
    ocrText = await extractText(bytes);
    if (ocrText == null) {
      // extractText already terminated the cached worker and logged the
      // timeout. Surface a clean reason up to the dashboard.
      return {
        data: null,
        reason: `OCR timed out after ${25_000}ms — receipt image may be too large or unsupported`,
      };
    }
    logv.info(
      `[verifier] tesseract OCR done in ${Date.now() - ocrStartedAt}ms ` +
        `textLen=${ocrText.length}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : typeof err;
    logv.warn(
      `[verifier] tesseract OCR failed: name=${name} message=${msg}`,
    );
    return {
      data: null,
      reason: `OCR failed: ${msg}`,
    };
  }

  // ocrText is non-null from here: the null case returned above.
  const ocrTextStr: string = ocrText;

  // Prefer URL flow if OCR spotted a bank URL inside the screenshot.
  const urlHit = findBankUrl(ocrTextStr);
  if (urlHit) {
    logv.info(
      `[verifier] OCR found bank URL provider=${urlHit.provider} url=${urlHit.url}`,
    );
    const data = await verifyFromUrl(urlHit.url, urlHit.provider);
    if (data) data.extractionMethod = "ocr-url";
    return { data };
  } else {
    logv.info(`OCR text contains no known-bank URL`);
  }

  const provider = detectProviderFromText(ocrTextStr);
  logv.info(`OCR provider sniff: ${provider ?? "<unknown>"}`);
  if (provider === "telebirr") {
    const data = parseTelebirrScreenshotFromText(ocrTextStr, `screenshot:${payment.receiptPath}`);
    data.extractionMethod = "screenshot-telebirr";
    logv.info(
      `[verifier] Telebirr screenshot parser refId=${data.referenceId || "<empty>"} ` +
        `amount=${data.amount ?? "<null>"}`,
    );
    if (data.referenceId) {
      return { data };
    }
    // No reference parsed — fall through to the reference-candidate flow
    // below, which can still look the receipt up by number.
  }

  // Last resort: pull reference-number candidates out of the OCR text and
  // run them through the transaction-number flow. Every provider has a
  // txn/receipt lookup, so this rescues screenshots that show a reference
  // but have no scannable QR or bank URL. Misreads are safe: the fetched
  // receipt still has to pass the auto-approval gate (provider / amount /
  // receiver account) before anything is approved.
  const fallbackProvider =
    (payment.bankAccount ? providerForBankType(payment.bankAccount.type) : null) ??
    detectProviderFromText(ocrTextStr);
  if (fallbackProvider) {
    const candidates = extractReferenceCandidates(ocrTextStr);
    logv.info(
      `[verifier] OCR reference fallback provider=${fallbackProvider} ` +
        `candidates=${candidates.length} [${candidates.slice(0, 3).join(", ")}]`,
    );
    let lastTxnError: string | null = null;
    for (const ref of candidates.slice(0, 3)) {
      const { data, reason } = await verifyFromTransactionNumber(
        ref,
        payment.bankAccount,
        payment.phoneNumber ?? null,
        fallbackProvider,
      );
      if (data && data.referenceId) {
        data.extractionMethod = "ocr-txn";
        return { data };
      }
      if (reason) lastTxnError = reason;
    }
    if (candidates.length > 0) {
      found.push(
        `reference number(s) ${candidates.slice(0, 3).join(", ")}`,
      );
      if (lastTxnError) {
        found.push(`but their lookup failed: ${lastTxnError}`);
      }
    }
  }

  if (found.length > 0) {
    return {
      data: null,
      reason: `The receipt could not be verified automatically: ${found.join(", ")}.`,
    };
  }

  return {
    data: null,
    reason:
      "Could not verify this screenshot automatically: no QR code, bank URL, or readable reference number was found. " +
      "Submit the SMS text or the transaction/receipt number instead.",
  };
}

/**
 * Pull plausible transaction-reference numbers out of OCR text. Conservative
 * on purpose: only values that follow an explicit label ("Ref:", "Transaction
 * ID: ..."). Anything misread here is caught downstream by the auto-approval
 * gate, but we still don't want to spray random tokens at bank APIs.
 */
const REFERENCE_LABEL_RE =
  /\b(?:ref|reference|ref\.?\s*no\.?|reference number|txn|trx|transaction|transaction id|trans id|receipt no\.?|receipt number)\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9\-\/]{4,24})/g;

export function extractReferenceCandidates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REFERENCE_LABEL_RE)) {
    const ref = m[1].replace(/[.,;:]+$/, "").toUpperCase();
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

/**
 * SMS flow — look for a known-bank URL in the pasted text.
 */
async function verifyFromSms(text: string): Promise<{
  data: ReceiptData | null;
  reason?: string;
}> {
  logv.info(`verifyFromSms textLen=${text.length}`);
  const urlHit = findBankUrl(text);
  if (urlHit) {
    logv.info(
      `[verifier] SMS contains bank URL provider=${urlHit.provider} url=${urlHit.url}`,
    );
    const data = await verifyFromUrl(urlHit.url, urlHit.provider);
    if (data) data.extractionMethod = "sms-url";
    return { data };
  }
  logv.info(`SMS contains no known-bank URL`);
  return {
    data: null,
    reason: "SMS does not contain a recognized bank receipt URL.",
  };
}

export async function verifyPayment(payment: VerifiablePayment): Promise<VerifyResult> {
  logv.info(
    `[verifier] verifyPayment start id=${payment.id} ` +
      `receiptType=${payment.receiptType} receiptPath=${payment.receiptPath}`,
  );
  try {
    const t = payment.receiptType;

    if (t === "TRANSACTION_NUMBER") {
      logv.info(`verifyPayment routing to TRANSACTION_NUMBER path`);
      const { data, reason } = await verifyFromTransactionNumber(
        payment.receiptPath,
        payment.bankAccount,
        payment.phoneNumber ?? null,
      );
      if (data && data.referenceId) {
        logv.info(
          `[verifier] verifyPayment VERIFIED via TXN refId=${data.referenceId} ` +
            `provider=${data.provider}`,
        );
        return { status: "VERIFIED", data };
      }
      logv.warn(
        `[verifier] verifyPayment UNVERIFIED via TXN reason=${reason ?? "Could not parse TXN."}`,
      );
      return { status: "UNVERIFIED", data, reason: reason ?? "Could not parse transaction number." };
    }

    if (t === "SMS_TEXT") {
      logv.info(`verifyPayment routing to SMS path`);
      const { data, reason } = await verifyFromSms(payment.receiptPath);
      if (data && data.referenceId) {
        logv.info(
          `[verifier] verifyPayment VERIFIED via SMS refId=${data.referenceId}`,
        );
        return { status: "VERIFIED", data };
      }
      logv.warn(
        `[verifier] verifyPayment UNVERIFIED via SMS reason=${reason ?? "Could not parse SMS."}`,
      );
      return { status: "UNVERIFIED", data, reason: reason ?? "Could not parse SMS." };
    }

    if (t === "IMAGE" || t === "SMS_SCREENSHOT") {
      logv.info(`verifyPayment routing to IMAGE path`);
      const { data, reason } = await verifyFromImage(payment);
      if (data && data.referenceId) {
        logv.info(
          `[verifier] verifyPayment VERIFIED via IMAGE refId=${data.referenceId} ` +
            `provider=${data.provider}`,
        );
        return { status: "VERIFIED", data };
      }
      logv.warn(
        `[verifier] verifyPayment UNVERIFIED/SKIPPED via IMAGE reason=${reason ?? "Could not extract a reference id."}`,
      );
      return {
        status: data ? "UNVERIFIED" : "SKIPPED",
        data,
        reason: reason ?? "Could not extract a reference id from the receipt.",
      };
    }

    logv.warn(`verifyPayment SKIPPED unsupported receiptType=${t}`);
    return { status: "SKIPPED", reason: `Unsupported receipt type: ${t}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : typeof err;
    logv.warn(`verifyPayment ERROR name=${name} message=${message}`);
    return { status: "ERROR", reason: message };
  }
}

/**
 * Transaction-number flow. Routes to the per-provider lookups using the
 * project's bank account. CBE / Dashen / Awash / BoA / Zemen receipts are
 * fetched from the URL form ({ref}{suffix}); CBE Birr and M-Pesa hit their
 * respective APIs. `providerOverride` lets the OCR fallback route by a
 * provider sniffed from the receipt when no bank account is selected.
 */
async function verifyFromTransactionNumber(
  txn: string,
  bankAccount: VerifiablePayment["bankAccount"],
  phoneNumber: string | null,
  providerOverride?: Provider,
): Promise<{ data: ReceiptData | null; reason?: string }> {
  const trimmed = txn.trim();
  if (!trimmed) {
    return { data: null, reason: "Transaction number is empty." };
  }
  const provider =
    providerOverride ??
    (bankAccount ? providerForBankType(bankAccount.type) : null);
  logv.info(
    `verifyFromTransactionNumber bankType=${bankAccount?.type ?? "<none>"} ` +
      `provider=${provider ?? "<none>"} txn=${trimmed.slice(0, 20)}…`,
  );
  if (!provider) {
    return {
      data: null,
      reason: `No provider mapped for bank type ${bankAccount?.type ?? "<none>"}.`,
    };
  }
  try {
    let data: ReceiptData;
    let url: string;
    switch (provider) {
      case "cbe": {
        url = `https://mbreciept.cbe.com.et/${encodeURIComponent(trimmed)}`;
        const { json, raw } = await fetchCbeApi(url);
        data = parseCbeFromApiJson(json, url, raw);
        data.extractionMethod = "txn-cbe-api";
        break;
      }
      case "boa": {
        url = `https://cs.bankofabyssinia.com/slip/?trx=${encodeURIComponent(trimmed)}`;
        data = await parseBoaFromUrl(url);
        data.extractionMethod = "txn-boa";
        break;
      }
      case "dashen": {
        url = `https://receipt.dashensuperapp.com/receipt/${encodeURIComponent(trimmed)}`;
        const buf = await fetchPdf(url, "dashen");
        data = await parseDashenFromPdfBuffer(buf, url);
        data.extractionMethod = "txn-dashen";
        break;
      }
      case "awash": {
        url = `https://awashpay.awashbank.com/?trx=${encodeURIComponent(trimmed)}`;
        const html = await fetchHtml(url, "awash");
        data = await parseAwashFromHtml(html, url);
        data.extractionMethod = "txn-awash";
        break;
      }
      case "zemen": {
        url = `https://share.zemenbank.com/receipt/${encodeURIComponent(trimmed)}`;
        const buf = await fetchPdf(url, "zemen");
        data = await parseZemenFromPdfBuffer(buf, url);
        data.extractionMethod = "txn-zemen";
        break;
      }
      case "telebirr": {
        url = `https://transactioninfo.ethiotelecom.et/receipt/${encodeURIComponent(trimmed)}`;
        data = await parseTelebirrFromUrl(url);
        data.extractionMethod = "txn-telebirr";
        break;
      }
      case "cbe-birr": {
        const phone = phoneNumber ?? bankAccount?.phoneNumber ?? null;
        if (!phone) {
          return {
            data: null,
            reason:
              "CBE Birr requires a phone number. Enable CBE Birr on the project and capture the customer's phone.",
          };
        }
        const birrUrl = buildCbeBirrUrl(trimmed, phone);
        const buf = await fetchPdf(birrUrl, "cbe-birr");
        data = await parseCbeBirrFromPdfBuffer(buf, birrUrl);
        data.extractionMethod = "txn-cbe-birr";
        break;
      }
      case "mpesa": {
        const { pdfBuffer } = await fetchMpesaApi(trimmed);
        const sourceUrl = `mpesa-api:trxNo=${trimmed}`;
        data = await parseMpesaFromPdfBuffer(pdfBuffer, sourceUrl);
        data.extractionMethod = "txn-mpesa";
        break;
      }
    }
    return { data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logv.warn(
      "verifyFromTransactionNumber: provider fetch/parse failed",
      { provider, txnPrefix: trimmed.slice(0, 12), err: msg },
    );
    return { data: null, reason: msg };
  }
}

// ---------------------------------------------------------------------------
// Auto-approval decision
// ---------------------------------------------------------------------------

/** Freshness window — receipts older than this are not auto-approved. */
export const PAYMENT_MAX_AGE_DAYS = 7;

/** Tolerance for amount match, in minor units (default 100 = 1.00 ETB). */
export const AMOUNT_TOLERANCE_MINOR = 100;

/**
 * Return the paymentDate as a millisecond timestamp, or `null` if it can't
 * be parsed. Accepts the literal text outputs each bank uses.
 */
function paymentDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isFinite(t)) return t;
  // Try Telebirr / Zemen "28-05-2026" style (DD-MM-YYYY) which `Date.parse`
  // treats as MM-DD-YYYY and gets wrong in non-US locales.
  const m = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\b/);
  if (m) {
    const d = new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T00:00:00Z`);
    const t2 = d.getTime();
    if (Number.isFinite(t2)) return t2;
  }
  return null;
}

/**
 * Extract the comparable digits of an account number. Bank receipts often
 * mask accounts ("1*******0189") — only the tail after the last mask
 * character is visible, so compare that tail against the same-length tail
 * of the configured account. Comparing a masked value as if it were whole
 * produces spurious mismatches. Returns null when there aren't enough
 * visible digits to compare.
 */
function accountCompareDigits(
  value: string | null | undefined,
): { digits: string; masked: boolean } | null {
  if (!value) return null;
  const masked = value.includes("*");
  const source = masked ? value.slice(value.lastIndexOf("*") + 1) : value;
  const digits = source.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return { digits, masked };
}

/** Accounts match when the receipt's visible tail equals the configured account's tail. */
function receiverAccountMatches(
  accountNumber: string,
  receiverAccount: string | null | undefined,
): { status: "pass" | "fail" | "skip"; expectedTail?: string; receiptTail?: string } {
  const expected = accountCompareDigits(accountNumber);
  const receipt = accountCompareDigits(receiverAccount ?? null);
  if (!expected || !receipt) return { status: "skip" };
  const compareLen = receipt.masked
    ? receipt.digits.length
    : Math.min(8, receipt.digits.length, expected.digits.length);
  const expectedTail = expected.digits.slice(-compareLen);
  const receiptTail = receipt.digits.slice(-compareLen);
  return expectedTail === receiptTail
    ? { status: "pass", receiptTail }
    : { status: "fail", expectedTail, receiptTail };
}

/**
 * Auto-approval gate. All of these must hold:
 *   - the verifier produced a non-empty `referenceId`
 *   - the extracted amount matches the order (within tolerance)
 *   - the receipt's date is no older than PAYMENT_MAX_AGE_DAYS days
 *   - if a project bank-account is selected, the receipt provider matches
 *     the bank-account's `BankType` and the receiver account matches the
 *     project's account number (masked receipt accounts are compared on
 *     their visible tail only)
 *
 * `orderAmountMinor` is the authoritative value — we never compare floats.
 */
export function shouldAutoApprove(
  orderAmountMinor: number,
  data: ReceiptData,
  bankAccount: Pick<BankAccount, "type" | "accountNumber"> | null,
): { ok: boolean; reason?: string } {
  if (!data.referenceId) {
    return { ok: false, reason: "Receipt is missing a reference id." };
  }
  const dataMinor = data.amount == null ? null : toMinor(data.amount);
  if (dataMinor === null) {
    return { ok: false, reason: "Receipt is missing an amount." };
  }
  if (!amountsMatchMinor(orderAmountMinor, dataMinor, AMOUNT_TOLERANCE_MINOR)) {
    return {
      ok: false,
      reason: `Amount mismatch (order=${fromMinor(orderAmountMinor)} ETB, receipt=${data.amount} ETB).`,
    };
  }
  const ts = paymentDateMs(data.paymentDate);
  if (ts !== null) {
    const ageMs = Date.now() - ts;
    if (ageMs < 0) {
      return { ok: false, reason: "Receipt date is in the future." };
    }
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > PAYMENT_MAX_AGE_DAYS) {
      return {
        ok: false,
        reason: `Receipt is ${ageDays.toFixed(1)} days old (>${PAYMENT_MAX_AGE_DAYS} day window).`,
      };
    }
  }
  if (bankAccount) {
    const expectedProvider = providerForBankType(bankAccount.type);
    if (expectedProvider && expectedProvider !== data.provider) {
      return {
        ok: false,
        reason: `Provider mismatch (selected=${bankAccount.type}, receipt=${data.provider}).`,
      };
    }
    const acctVerdict = receiverAccountMatches(
      bankAccount.accountNumber,
      data.receiverAccount,
    );
    if (acctVerdict.status === "fail") {
      return {
        ok: false,
        reason: `Receiver account mismatch (account ends …${acctVerdict.expectedTail}, receipt shows …${acctVerdict.receiptTail}).`,
      };
    }
  }
  return { ok: true };
}

// Re-export `detectProvider` so consumers (tests, future endpoints) can route
// a URL without re-importing from `./detector`.
export { detectProvider };
// `providerForBankType` lives in `./bank-type` so client components can
// import it without dragging in `sharp`, `tesseract.js`, `node:fs` etc.
// Re-export here for server-side code that already imports from `./verify`.
export { providerForBankType };
// Types are exported at the top of the file.
