/**
 * Telebirr HTML receipt parser.
 * Port of local Python `telebirr.py` (regex over normalised page text).
 *
 * Accepts a full URL or a bare receipt ID — we build the URL internally.
 */

import * as cheerio from "cheerio";
import { fetchHtml } from "../fetcher.js";
import { emptyReceipt, normalizeDate, parseAmount } from "./base.js";
import type { ReceiptData } from "../types.js";
import { log } from "../../log.js";
const logv = log.child({ module: "parser.telebirr" });

const BASE = "https://transactioninfo.ethiotelecom.et/receipt/";

export function buildTelebirrUrl(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  if (trimmed.startsWith("http")) return trimmed;
  return BASE + trimmed;
}

function find(text: string, pattern: RegExp): string | null {
  const m = text.match(pattern);
  return m ? m[1].trim() : null;
}

function mapToReceipt(html: string, sourceUrl: string): ReceiptData {
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  const ref = find(text, /([A-Z]{2}[A-Z0-9]{6,12})\s+\d{2}-\d{2}-\d{4}/);
  const paymentDate = find(text, /(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/);
  const amountStr   = find(text, /\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2}\s+([\d,]+)\s*Birr/);

  const vatStr           = find(text, /15%\s+\S+\/VAT\s+([\d,.]+)\s*Birr/i);
  const serviceFeeStr    = find(text, /\bservice fee\b\s+([\d,]+)\s*Birr(?!\s*[A-Z])/i);
  const serviceFeeVatStr = find(text, /Service fee VAT\s+([\d,]+)\s*Birr/i);
  const totalPaidStr     = find(text, /Total Paid Amount\s+([\d,]+)\s*Birr/i);

  const payerName = find(
    text,
    /Payer Name\s+(.+?)(?=\s+(?:[^\x00-\x7F\s]+\s+)*\S+\/Payer telebirr|\s+Payer telebirr|\s+Payer account)/i,
  );
  const payerPhone    = find(text, /Payer telebirr no\.\s+(\d[\d*]+)/i);
  const receiverName  = find(
    text,
    /Credited Party name\s+(.+?)(?=\s+(?:[^\x00-\x7F\s]+\s+)*\S+\/Credited party account|\s+Credited party account|\s+transaction status)/i,
  );
  const receiverAccount = find(text, /Credited party account no\s+(\S+)/i);

  const paymentMode      = find(text, /Payment Mode\s+(\S+)/);
  const paymentReason    = find(
    text,
    /Payment Reason\s+(.+?)(?=\s+(?:[^\x00-\x7F\s]+\s+)*\S+\/Payment channel|\s+Payment channel)/i,
  );
  const paymentChannel   = find(text, /Payment channel\s+(\S+)/);

  const sf  = parseAmount(serviceFeeStr);
  const sfv = parseAmount(serviceFeeVatStr);
  const totalSf = sf != null || sfv != null ? (sf ?? 0) + (sfv ?? 0) : null;

  const data = emptyReceipt("telebirr", sourceUrl);
  data.referenceId      = ref ?? "";
  data.paymentDate      = normalizeDate(paymentDate);
  data.amount           = parseAmount(amountStr);
  data.vat              = parseAmount(vatStr);
  data.serviceFee       = totalSf;
  data.totalPaid        = parseAmount(totalPaidStr);
  data.payerName        = payerName;
  data.payerPhone       = payerPhone;
  data.receiverName     = receiverName;
  data.receiverAccount  = receiverAccount;
  data.paymentMode      = paymentMode;
  data.paymentReason    = paymentReason;
  data.paymentChannel   = paymentChannel;
  return data;
}

export async function parseTelebirrFromHtml(
  html: string,
  sourceUrl: string,
): Promise<ReceiptData> {
  logv.info(`parseTelebirr.html htmlLen=${html.length} sourceUrl=${sourceUrl}`);
  const data = mapToReceipt(html, sourceUrl);
  logv.info(
    `[verifier] parseTelebirr.html done refId=${data.referenceId || "<empty>"} ` +
      `amount=${data.amount ?? "<null>"}`,
  );
  return data;
}

/** Convenience: takes a bare ID or full URL, fetches the page, parses. */
export async function parseTelebirrFromUrl(idOrUrl: string): Promise<ReceiptData> {
  logv.info(`parseTelebirr.url idOrUrl=${idOrUrl}`);
  const url = buildTelebirrUrl(idOrUrl);
  logv.info(`parseTelebirr.url built url=${url}`);
  const html = await fetchHtml(url, "telebirr");
  return mapToReceipt(html, url);
}
