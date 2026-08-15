/**
 * CBE API receipt parser.
 *
 * QR codes in CBE mobile-app screenshots encode a URL like
 * `https://mbreciept.cbe.com.et/{token}`. We call the CBE JSON API at
 * `https://mb.cbe.com.et/api/v1/transactions/public/transaction-detail/{token}`
 * and map the response into `ReceiptData`.
 */

import { emptyReceipt } from "./base.js";
import type { ReceiptData } from "../types.js";
import { log } from "../../log.js";
const logv = log.child({ module: "parser.cbe" });

interface CbeCommission {
  commissionType: string;
  commissionAmt: string;
}

interface CbeTax {
  taxType: string;
  taxAmt: string;
}

interface CbeApiResponse {
  id?: string;
  transactionType?: string;
  debitAccountNo?: string;
  debitAccountHolder?: string;
  debitCurrency?: string;
  debitAmount?: string;
  creditAccountNo?: string;
  creditAccountHolder?: string;
  creditCurrency?: string;
  creditAmount?: string;
  amountDebited?: string;
  amountCredited?: string;
  totalChargeAmount?: string;
  totalTaxAmount?: string;
  paymentDetails?: string[];
  commissionTypes?: CbeCommission[];
  taxTypes?: CbeTax[];
  dateTimes?: string[];
  debitValueDate?: string;
  processingDate?: string;
  encodedReceipt?: string;
}

function parseCbeCurrencyAmount(text: string | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/^[A-Z]{3}/, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the CBE JSON API response into a `ReceiptData`.
 *
 * When the QR code from a CBE mobile-app screenshot is scanned, it points to
 * `https://mbreciept.cbe.com.et/{token}`. Instead of fetching the PDF, we
 * call `https://mb.cbe.com.et/api/v1/transactions/public/transaction-detail/{token}`
 * and parse its JSON response.
 */
export function parseCbeFromApiJson(
  payload: unknown,
  sourceUrl: string,
  raw?: string,
): ReceiptData {
  const p = payload as CbeApiResponse;
  logv.info(`parseCbe.apiJson refId=${p.id ?? "<empty>"} sourceUrl=${sourceUrl}`);

  const data = emptyReceipt("cbe", sourceUrl);
  data.referenceId     = p.id ?? "";
  data.payerName       = p.debitAccountHolder ?? null;
  data.payerAccount    = p.debitAccountNo ?? null;
  data.receiverName    = p.creditAccountHolder ?? null;
  data.receiverAccount = p.creditAccountNo ?? null;
  data.amount          = p.debitAmount ? Number(p.debitAmount) : null;
  data.paymentDate     = p.dateTimes?.length ? p.dateTimes[0] : null;
  data.narrative       = p.paymentDetails?.length ? p.paymentDetails[0] : null;
  data.transactionType = p.transactionType ?? null;
  data.totalPaid       = p.amountDebited ? Number(p.amountDebited) : null;

  if (p.commissionTypes?.length) {
    data.serviceFee = p.commissionTypes.reduce(
      (sum, c) => sum + (parseCbeCurrencyAmount(c.commissionAmt) ?? 0),
      0,
    );
  }
  if (p.taxTypes?.length) {
    data.vat = p.taxTypes.reduce(
      (sum, t) => sum + (parseCbeCurrencyAmount(t.taxAmt) ?? 0),
      0,
    );
  }

  if (raw) data.rawResponse = raw;

  logv.info(
    `[verifier] parseCbe.apiJson done refId=${data.referenceId || "<empty>"} ` +
      `amount=${data.amount ?? "<null>"}`,
  );
  return data;
}
