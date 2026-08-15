/**
 * Telebirr screenshot (OCR) parser.
 * Port of local Python `parsers/screenshot_telebirr.py`.
 */

import { emptyReceipt, normalizeDate, parseAmount } from "./base.js";
import type { ReceiptData } from "../types.js";

function find(text: string, pattern: RegExp): string | null {
  const m = text.match(pattern);
  return m ? m[1].trim() : null;
}

export function parseTelebirrScreenshotFromText(
  ocrText: string,
  sourceUrl = "screenshot",
): ReceiptData {
  const text = ocrText.replace(/\s+/g, " ");

  const referenceId    = find(text, /Transaction Number[:\s]+([A-Z0-9]+)/i);
  // "-2.00 (ETB)" or "-2.00 ETB" — take absolute value
  const amountStr      = find(text, /-\s*([\d,]+\.?\d*)\s*\(?ETB\)?/i);
  const paymentDate    = find(text, /Transaction Time[:\s]+([\d/]+\s+[\d:]+)/i);
  const transactionType = find(
    text,
    /Transaction Type[:\s]+(.+?)(?=\s+Transaction\b|\s+QR Code|$)/i,
  );
  const receiverName   = find(
    text,
    /Transaction To[:\s]+(.+?)(?=\s+Transaction\b|\s+QR Code|$)/i,
  );

  const data = emptyReceipt("telebirr", sourceUrl);
  data.referenceId     = referenceId ?? "";
  data.receiverName    = receiverName;
  data.amount          = parseAmount(amountStr);
  data.paymentDate     = normalizeDate(paymentDate);
  data.transactionType = transactionType;
  return data;
}
