/**
 * CBE Birr PDF receipt parser.
 *
 * CBE Birr receipts are served as PDFs from
 *   https://cbepay1.cbe.com.et/aureceipt?TID={receiptNumber}&PH={phoneNumber}
 *
 * The PDF layout is brittle: the "labels" we key off sit above the values,
 * but their relative order and spacing varies between CBE template revisions.
 * The regex set below covers the format observed in 2025/2026; expect
 * occasional breakages when CBE rotates the template.
 *
 * Inputs: receiptNumber (10-char alphanumeric), phoneNumber (2519XXXXXXXX).
 * Output: `ReceiptData` with the canonical fields, or partial (empty
 * referenceId) if nothing parsed cleanly.
 */

import { Buffer } from "node:buffer";
import { emptyReceipt, parseAmount } from "./base.js";
import { extractPdfText } from "./pdf.js";
import type { ReceiptData } from "../types.js";
import { log } from "../../log.js";

const logv = log.child({ module: "parser.cbe-birr" });

const CBE_BIRR_BASE = "https://cbepay1.cbe.com.et/aureceipt";

export function buildCbeBirrUrl(receiptNumber: string, phoneNumber: string): string {
  return `${CBE_BIRR_BASE}?TID=${encodeURIComponent(receiptNumber)}&PH=${encodeURIComponent(phoneNumber)}`;
}

function find(text: string, pattern: RegExp): string | null {
  const m = text.match(pattern);
  return m ? m[1].trim() : null;
}

function mapToReceipt(rawText: string, sourceUrl: string): ReceiptData {
  // Collapse whitespace so label-and-value can sit on the same line.
  const text = rawText.replace(/\s+/g, " ").replace(/\n/g, " ");

  const data = emptyReceipt("cbe-birr", sourceUrl);

  // Reference — the receipt number is printed under "Transaction Reference" or
  // "Receipt Number" labels. We also try the original receipt ID itself as a
  // fallback because CBE sometimes prints it twice.
  data.referenceId =
    find(text, /Transaction\s*Reference\s*[:\-]?\s*([A-Za-z0-9]+)/i) ??
    find(text, /Receipt\s*Number\s*[:\-]?\s*([A-Za-z0-9]+)/i) ??
    find(text, /Reference\s*No\.?\s*[:\-]?\s*([A-Za-z0-9]+)/i) ??
    "";

  data.payerName =
    find(text, /Payer\s*Name\s*[:\-]?\s*([A-Z][A-Za-z\s.'-]+?)(?=\s+(?:Payer\s*Telebirr|Payer\s*Phone|Payer\s*Number|Receiver|Receiver\s*Name|Beneficiary|$))/i) ??
    find(text, /From\s*[:\-]?\s*([A-Z][A-Za-z\s.'-]+?)(?=\s+(?:To|Beneficiary|Receiver|Amount|$))/i);

  data.receiverName =
    find(text, /Receiver\s*Name\s*[:\-]?\s*([A-Z][A-Za-z\s.'-]+?)(?=\s+(?:Receiver\s*Account|Beneficiary\s*Account|Amount|$))/i) ??
    find(text, /Beneficiary\s*Name\s*[:\-]?\s*([A-Z][A-Za-z\s.'-]+?)(?=\s+(?:Beneficiary\s*Account|Amount|$))/i);

  data.receiverAccount =
    find(text, /Receiver\s*Account\s*[:\-]?\s*([0-9]+)/i) ??
    find(text, /Beneficiary\s*Account\s*[:\-]?\s*([0-9]+)/i);

  data.payerAccount =
    find(text, /Payer\s*Account\s*[:\-]?\s*([0-9]+)/i) ??
    find(text, /From\s*Account\s*[:\-]?\s*([0-9]+)/i);

  data.payerPhone =
    find(text, /Payer\s*(?:Telebirr|Phone|Number)\s*[:\-]?\s*(251\d{9})/i) ??
    find(text, /\b(251\d{9})\b/);

  // Amount — "Settled Amount" or "Transaction Amount" or "Amount" label.
  data.amount =
    parseAmount(find(text, /Settled\s*Amount\s*[:\-]?\s*([\d,]+\.?\d*)/i)) ??
    parseAmount(find(text, /Transaction\s*Amount\s*[:\-]?\s*([\d,]+\.?\d*)/i)) ??
    parseAmount(find(text, /(?:^|\s)Amount\s*[:\-]?\s*([\d,]+\.?\d*)/i));

  data.serviceFee =
    parseAmount(find(text, /Service\s*Charge\s*[:\-]?\s*([\d,]+\.?\d*)/i)) ??
    parseAmount(find(text, /Service\s*Fee\s*[:\-]?\s*([\d,]+\.?\d*)/i));

  data.vat =
    parseAmount(find(text, /VAT\s*15%\s*[:\-]?\s*([\d,]+\.?\d*)/i)) ??
    parseAmount(find(text, /VAT\s*[:\-]?\s*([\d,]+\.?\d*)/i));

  data.totalPaid =
    parseAmount(find(text, /Total\s*Amount\s*[:\-]?\s*([\d,]+\.?\d*)/i)) ??
    parseAmount(find(text, /Total\s*[:\-]?\s*([\d,]+\.?\d*)/i));

  data.transactionType =
    find(text, /Transaction\s*Type\s*[:\-]?\s*([A-Za-z\s-]+?)(?=\s+(?:Amount|Date|Status|$))/i);

  data.paymentDate =
    find(text, /Transaction\s*Date\s*[:\-]?\s*([\d\/\-\s:]+?)(?=\s+(?:Amount|Status|$))/i) ??
    find(text, /Date\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\s*\d{1,2}:\d{2}(?::\d{2})?)/i) ??
    find(text, /Date\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i);

  data.narrative =
    find(text, /Reason\s*[:\-]?\s*(.+?)(?=\s+(?:Amount|Status|Date|$))/i) ??
    find(text, /Narration\s*[:\-]?\s*(.+?)(?=\s+(?:Amount|Status|Date|$))/i);

  return data;
}

export async function parseCbeBirrFromPdfBuffer(
  buffer: Buffer,
  sourceUrl: string,
): Promise<ReceiptData> {
  logv.info(`parseCbeBirr.pdfBuffer bytes=${buffer.length} sourceUrl=${sourceUrl}`);
  const text = await extractPdfText(buffer);
  const data = mapToReceipt(text, sourceUrl);
  logv.info(
    `[verifier] parseCbeBirr.pdfBuffer done refId=${data.referenceId || "<empty>"} ` +
      `amount=${data.amount ?? "<null>"}`,
  );
  return data;
}
