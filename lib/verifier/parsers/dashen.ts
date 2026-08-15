/**
 * Dashen Bank PDF receipt parser.
 * Port of upstream `dashen.py` to TypeScript with the unified `ReceiptData` shape.
 */

import { Buffer } from "node:buffer";
import { emptyReceipt, normalizeDate, parseAmount } from "./base.js";
import { extractPdfText } from "./pdf.js";
import type { ReceiptData } from "../types.js";
import { log } from "../../log.js";
const logv = log.child({ module: "parser.dashen" });

function find(text: string, pattern: RegExp): string | null {
  const m = text.match(pattern);
  return m ? m[1].trim() : null;
}

function mapToReceipt(rawText: string, sourceUrl: string): ReceiptData {
  const text = rawText.replace(/\n/g, " ");

  const data = emptyReceipt("dashen", sourceUrl);

  data.payerName         = find(text, /Account Holder Name:\s*(.+?)(?:\n|$)/);
  data.transactionType   = find(text, /Transaction Channel:\s*(.+?)(?:\n|$)/);
  data.paymentMode       = find(text, /Service Type:\s*(.+?)(?:\n|$)/);
  data.narrative         = find(text, /Narrative:\s*(.+?)(?:\n|$)/);
  data.receiverName      = find(text, /Beneficiary Name:\s*(.+?)(?:\n|$)/);
  data.receiverAccount   = find(text, /Account Number:\s*(\d+)/);
  data.receiverBank      = find(text, /Institution Name:\s*(.+?)(?:\n|$)/);
  data.referenceId       = find(text, /Transaction Ref:\s*(.+?)(?:\n|$)/)
                         ?? find(text, /Transfer Reference:\s*(.+?)(?:\n|$)/)
                         ?? "";
  data.paymentDate       = normalizeDate(find(text, /Date:\s*(.+?)(?:\n|$)/));
  data.amount            = parseAmount(find(text, /Transaction Amount\s*([\d,.]+)\s*ETB/));
  data.totalPaid         = parseAmount(find(text, /Total\s*([\d,.]+)\s*ETB/));
  return data;
}

export async function parseDashenFromPdfText(
  text: string,
  sourceUrl: string,
): Promise<ReceiptData> {
  logv.info(`parseDashen.pdfText textLen=${text.length} sourceUrl=${sourceUrl}`);
  const data = mapToReceipt(text, sourceUrl);
  logv.info(
    `[verifier] parseDashen.pdfText done refId=${data.referenceId || "<empty>"} ` +
      `amount=${data.amount ?? "<null>"}`,
  );
  return data;
}

export async function parseDashenFromPdfBuffer(
  buffer: Buffer,
  sourceUrl: string,
): Promise<ReceiptData> {
  logv.info(`parseDashen.pdfBuffer bytes=${buffer.length} sourceUrl=${sourceUrl}`);
  const text = await extractPdfText(buffer);
  const data = mapToReceipt(text, sourceUrl);
  logv.info(
    `[verifier] parseDashen.pdfBuffer done refId=${data.referenceId || "<empty>"} ` +
      `amount=${data.amount ?? "<null>"}`,
  );
  return data;
}
