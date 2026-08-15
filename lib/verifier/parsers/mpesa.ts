/**
 * M-Pesa PDF receipt parser.
 *
 * M-Pesa (Ethio Telecom) receipts come back from
 *   https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo=…
 * as JSON containing a base64-encoded PDF (`base64Data`). The PDF text is
 * keyed off the same English labels as the other Ethiopian mobile-money
 * banks (Transaction Number, Amount, Payer, Receiver, Date, …) but the
 * labels can show up in either English or Amharic. We stick to English for
 * now; the receipt always has both.
 *
 * Inputs: a Buffer containing the PDF bytes.
 * Output: `ReceiptData` with the canonical fields.
 */

import { Buffer } from "node:buffer";
import { emptyReceipt, parseAmount } from "./base.js";
import { extractPdfText } from "./pdf.js";
import type { ReceiptData } from "../types.js";
import { log } from "../../log.js";

const logv = log.child({ module: "parser.mpesa" });

function find(text: string, pattern: RegExp): string | null {
  const m = text.match(pattern);
  return m ? m[1].trim() : null;
}

function mapToReceipt(rawText: string, sourceUrl: string): ReceiptData {
  const text = rawText.replace(/\s+/g, " ").replace(/\n/g, " ");

  const data = emptyReceipt("mpesa", sourceUrl);

  data.referenceId =
    find(text, /Transaction\s*Number\s*[:\-]?\s*([A-Za-z0-9]+)/i) ??
    find(text, /Receipt\s*Number\s*[:\-]?\s*([A-Za-z0-9]+)/i) ??
    "";

  data.payerName =
    find(text, /Sender\s*Name\s*[:\-]?\s*([A-Z][A-Za-z\s.'-]+?)(?=\s+(?:Sender\s*(?:Number|Phone)|Receiver|Amount|$))/i) ??
    find(text, /From\s*[:\-]?\s*([A-Z][A-Za-z\s.'-]+?)(?=\s+(?:To|Receiver|Amount|$))/i);

  data.payerPhone =
    find(text, /Sender\s*(?:Number|Phone)\s*[:\-]?\s*(\+?\d[\d\s-]+)/i) ??
    find(text, /\b(\+?251\d{9})\b/);

  data.receiverName =
    find(text, /Receiver\s*Name\s*[:\-]?\s*([A-Z][A-Za-z\s.'-]+?)(?=\s+(?:Receiver\s*(?:Number|Account|Phone)|Amount|$))/i) ??
    find(text, /Beneficiary\s*Name\s*[:\-]?\s*([A-Z][A-Za-z\s.'-]+?)(?=\s+(?:Beneficiary\s*(?:Number|Account)|Amount|$))/i);

  data.receiverAccount =
    find(text, /Receiver\s*(?:Account|Number)\s*[:\-]?\s*(\+?\d[\d-]+)/i) ??
    find(text, /Beneficiary\s*(?:Account|Number)\s*[:\-]?\s*(\+?\d[\d-]+)/i);

  data.amount =
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

export async function parseMpesaFromPdfBuffer(
  buffer: Buffer,
  sourceUrl: string,
): Promise<ReceiptData> {
  logv.info(`parseMpesa.pdfBuffer bytes=${buffer.length} sourceUrl=${sourceUrl}`);
  const text = await extractPdfText(buffer);
  const data = mapToReceipt(text, sourceUrl);
  logv.info(
    `[verifier] parseMpesa.pdfBuffer done refId=${data.referenceId || "<empty>"} ` +
      `amount=${data.amount ?? "<null>"}`,
  );
  return data;
}
