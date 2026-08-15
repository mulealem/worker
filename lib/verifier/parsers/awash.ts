/**
 * Awash Bank HTML table receipt parser.
 * Port of upstream `awash.py` to cheerio.
 */

import * as cheerio from "cheerio";
import { emptyReceipt, parseAmount } from "./base.js";
import type { ReceiptData } from "../types.js";
import { log } from "../../log.js";
const logv = log.child({ module: "parser.awash" });

export async function parseAwashFromHtml(
  html: string,
  sourceUrl: string,
): Promise<ReceiptData> {
  logv.info(`parseAwash.html htmlLen=${html.length} sourceUrl=${sourceUrl}`);
  const $ = cheerio.load(html);
  const rows = $("table.info-table tr");

  const raw: Record<string, string> = {};
  rows.each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length === 3) {
      const key = $(cells[0]).text().trim().replace(/:$/, "");
      const value = $(cells[2]).text().trim();
      raw[key] = value;
    }
  });
  logv.info(
    `[verifier] parseAwash.html rawKeys=${JSON.stringify(Object.keys(raw))}`,
  );

  const data = emptyReceipt("awash", sourceUrl);
  data.transactionType = raw["Transaction Type"] ?? null;
  data.paymentDate     = raw["Transaction Time"] ?? null;
  data.amount          = parseAmount(raw["Amount"]);
  data.serviceFee      = parseAmount(raw["Charge"]);
  data.vat             = parseAmount(raw["VAT"]);
  data.payerName       = raw["Sender Name"] ?? null;
  data.payerAccount    = raw["Sender Account"] ?? null;
  data.receiverName    = raw["Beneficiary name"] ?? null;
  data.receiverAccount = raw["Beneficiary Account"] ?? null;
  data.receiverBank    = raw["Beneficiary Bank"] ?? null;
  data.paymentReason   = raw["Reason"] ?? null;
  data.referenceId     = raw["Transaction ID"] ?? "";
  logv.info(
    `[verifier] parseAwash.html done refId=${data.referenceId || "<empty>"} ` +
      `amount=${data.amount ?? "<null>"}`,
  );
  return data;
}
