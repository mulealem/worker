/**
 * Zemen Bank PDF receipt parser.
 * Port of upstream `zemen.py` with the upstream indentation bug fixed
 * (the `patterns` dict was being created at the wrong scope).
 */

import { Buffer } from "node:buffer";
import { emptyReceipt, normalizeDate, parseAmount } from "./base.js";
import { extractPdfText } from "./pdf.js";
import type { ReceiptData } from "../types.js";
import { log } from "../../log.js";
const logv = log.child({ module: "parser.zemen" });

function find(text: string, pattern: RegExp): string | null {
  const m = text.match(pattern);
  return m ? m[1].trim() : null;
}

function mapToReceipt(rawText: string, sourceUrl: string): ReceiptData {
  const text = rawText.replace(/\s+/g, " ").replace(/\n/g, " ");

  const data = emptyReceipt("zemen", sourceUrl);
  data.referenceId    = find(text, /Reference No[:\s]+([A-Z0-9]+)/) ?? "";
  data.paymentDate    = normalizeDate(find(text, /Date[:\s]+(\d{1,2}-[A-Za-z]{3}-\d{4})/));
  data.payerName      = find(text, /Payer name:\s*([A-Z\s]+?)(?=\s+Payer account)/);
  data.payerAccount   = find(text, /Payer account no\.?:\s*([\d*X()]+)/);
  data.receiverName   = find(text, /Recipient name:\s*([A-Za-z\s.]+?)(?=\s+Recipient account)/);
  data.receiverAccount = find(text, /Recipient account no\.?:\s*([\d*]+)/);
  data.transactionType = find(text, /Transaction Detail\s+([A-Za-z\s-]+?)\s+ETB/);
  data.amount         = parseAmount(find(text, /(?:Settled Amount|ATM CASH WITHDRAWAL ETB\s*)([\d,]+\.\d{2})/));
  data.serviceFee     = parseAmount(find(text, /Service Charge ETB\s*([\d,]+\.\d{2})/));
  data.vat            = parseAmount(find(text, /VAT 15% ETB\s*([\d,]+\.\d{2})/));
  data.totalPaid      = parseAmount(find(text, /Total Amount Paid ETB\s*([\d,]+\.\d{2})/));
  return data;
}

export async function parseZemenFromPdfText(
  text: string,
  sourceUrl: string,
): Promise<ReceiptData> {
  logv.info(`parseZemen.pdfText textLen=${text.length} sourceUrl=${sourceUrl}`);
  const data = mapToReceipt(text, sourceUrl);
  logv.info(
    `[verifier] parseZemen.pdfText done refId=${data.referenceId || "<empty>"} ` +
      `amount=${data.amount ?? "<null>"}`,
  );
  return data;
}

export async function parseZemenFromPdfBuffer(
  buffer: Buffer,
  sourceUrl: string,
): Promise<ReceiptData> {
  logv.info(`parseZemen.pdfBuffer bytes=${buffer.length} sourceUrl=${sourceUrl}`);
  const text = await extractPdfText(buffer);
  const data = mapToReceipt(text, sourceUrl);
  logv.info(
    `[verifier] parseZemen.pdfBuffer done refId=${data.referenceId || "<empty>"} ` +
      `amount=${data.amount ?? "<null>"}`,
  );
  return data;
}
