/**
 * BoA JSON API receipt parser.
 *
 * Calls https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id={trx}
 * (the JSON API backing the public slip page) and maps the response to the
 * unified `ReceiptData`. Avoids the Chrome WebDriver approach the upstream
 * `ethiobank_receipts` library uses.
 */

import { fetchBoaJson } from "../fetcher.js";
import { emptyReceipt, parseAmount } from "./base.js";
import type { ReceiptData } from "../types.js";
import { log } from "../../log.js";
const logv = log.child({ module: "parser.boa" });

/** Coerce a `string | number | null | undefined` to a string (or null). */
function asString(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

export async function parseBoaFromUrl(slipUrl: string): Promise<ReceiptData> {
  logv.info(`parseBoa.url slipUrl=${slipUrl}`);
  const payload = await fetchBoaJson(slipUrl);
  const d = payload.body?.[0] ?? {};
  const fields = d as Record<string, string | number | null | undefined>;
  logv.info(
    `[verifier] parseBoa.url rawFields=${JSON.stringify(Object.keys(fields))}`,
  );

  const data = emptyReceipt("boa", slipUrl);
  data.referenceId    = asString(fields["Transaction Reference"]) ?? "";
  data.currency       = (asString(fields["currency"]) ?? "ETB").toUpperCase();
  data.payerName      = asString(fields["Payer's Name"]) ?? asString(fields["Source Account Name"]);
  data.payerAccount   = asString(fields["Source Account"]);
  data.payerPhone     = asString(fields["Tel."]);
  data.receiverName   = asString(fields["Receiver's Name"]);
  data.receiverAccount = asString(fields["Receiver's Account"]);
  data.amount         = parseAmount(asString(fields["Transferred Amount"]));
  data.serviceFee     = parseAmount(asString(fields["Service Charge"]));
  data.vat            = parseAmount(asString(fields["VAT (15%)"]));
  data.totalPaid      = parseAmount(asString(fields["Total Amount including VAT"]));
  data.paymentDate    = asString(fields["Transaction Date"]);
  data.transactionType = asString(fields["Transaction Type"]);
  data.narrative      = asString(fields["Narrative"]);
  logv.info(
    `[verifier] parseBoa.url done refId=${data.referenceId || "<empty>"} ` +
      `amount=${data.amount ?? "<null>"}`,
  );
  return data;
}
