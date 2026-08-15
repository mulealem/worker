/**
 * Unified shape for bank receipt extraction.
 * Each bank parser maps its native fields into this structure.
 */

export type Provider =
  | "cbe"
  | "telebirr"
  | "boa"
  | "dashen"
  | "awash"
  | "zemen"
  | "cbe-birr"
  | "mpesa";

export interface ReceiptData {
  provider: Provider;
  /** Canonical transaction id (used for matching) */
  referenceId: string;
  /** Canonical transferred amount in the receipt's currency */
  amount: number | null;
  /** ISO code; all current banks are ETB */
  currency: string;
  /** ISO 8601 if parseable, raw text otherwise */
  paymentDate: string | null;

  payerName: string | null;
  payerAccount: string | null;
  /** Telebirr only */
  payerPhone: string | null;

  receiverName: string | null;
  receiverAccount: string | null;
  /** Awash / Dashen only */
  receiverBank: string | null;

  serviceFee: number | null;
  vat: number | null;
  totalPaid: number | null;

  transactionType: string | null;
  paymentMode: string | null;
  paymentReason: string | null;
  paymentChannel: string | null;
  narrative: string | null;

  /** The URL the data was fetched from, or a label like "screenshot:foo.png" / "sms:text" */
  sourceUrl: string;

  /** Raw response from the bank API (JSON) preserved for debugging / audit */
  rawResponse?: unknown;

  /** How the data was extracted: "qr-cbe-api", "qr-cbe-pdf", "qr-url", "ocr-url",
   *  "ocr-cbe-ft", "screenshot-cbe", "screenshot-telebirr", "sms-url", etc. */
  extractionMethod?: string;
}

/** Result of running the verifier against a single Payment */
export type VerifyResult =
  | { status: "VERIFIED"; data: ReceiptData }
  | { status: "UNVERIFIED"; data: ReceiptData | null; reason: string }
  | { status: "SKIPPED"; reason: string }
  | { status: "ERROR"; reason: string };

/** Sidecar metadata written to Payment.extractedData.verification */
export interface VerificationMeta {
  status: "VERIFIED" | "UNVERIFIED" | "SKIPPED" | "ERROR";
  reason: string | null;
  autoApproved: boolean;
  verifiedAt: string;
}
