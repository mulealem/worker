/**
 * Per-provider receipt capabilities.
 *
 * Each bank exposes a different surface to the customer: some have a public
 * receipt URL (so IMAGE + SMS_TEXT work), some expose a transaction number
 * lookup (TRANSACTION_NUMBER), and CBE Birr / M-Pesa need an extra phone
 * number or receipt number and don't accept screenshots at all.
 *
 * The matrix below is consumed by:
 *   - the upload route (`app/api/payments/[orderId]/upload/route.ts`) which
 *     rejects unsupported receipt types with 400,
 *   - the sandbox route (`app/api/sandbox/verify/route.ts`),
 *   - the payment UI (`components/payment/ReceiptUploadForm.tsx`) which hides
 *     unsupported tabs,
 *   - the sandbox UI (`app/(dashboard)/dashboard/projects/[id]/sandbox/SandboxForm.tsx`).
 *
 * Provider keys here must match the lowercase `Provider` union in
 * `lib/verifier/types.ts`.
 */

import type { Provider } from "./types.js";
export type ReceiptType = "IMAGE" | "SMS_TEXT" | "SMS_SCREENSHOT" | "TRANSACTION_NUMBER";

export interface ProviderCapabilities {
  /** Customer can submit a screenshot of the receipt. */
  image: boolean;
  /** Customer can paste the SMS text the bank sent. */
  sms: boolean;
  /** Customer can paste the transaction / receipt number. */
  transactionNumber: boolean;
  /** Human-readable helper shown in the upload UI. */
  transactionNumberHelper: string;
  /** Whether the provider also needs a phone number (CBE_BIRR). */
  requiresPhoneNumber: boolean;
}

export const PROVIDER_CAPABILITIES: Record<Provider, ProviderCapabilities> = {
  cbe: {
    image: true,
    sms: false,
    transactionNumber: true,
    transactionNumberHelper:
      "For CBE: starts with FT and a long token, or paste the mbreciept.cbe.com.et URL.",
    requiresPhoneNumber: false,
  },
  telebirr: {
    image: true,
    sms: true,
    transactionNumber: true,
    transactionNumberHelper:
      "For Telebirr: a long alphanumeric ID from your Telebirr receipt.",
    requiresPhoneNumber: false,
  },
  boa: {
    image: true,
    sms: false,
    transactionNumber: true,
    transactionNumberHelper:
      "For Bank of Abyssinia: the FT reference followed by the 5-digit suffix from your receipt URL.",
    requiresPhoneNumber: false,
  },
  dashen: {
    image: true,
    sms: false,
    transactionNumber: true,
    transactionNumberHelper:
      "For Dashen: paste the receipt URL from receipt.dashensuperapp.com or the transaction reference.",
    requiresPhoneNumber: false,
  },
  awash: {
    image: true,
    sms: false,
    transactionNumber: true,
    transactionNumberHelper:
      "For Awash: paste the receipt URL from awashpay.awashbank.com or the transaction ID.",
    requiresPhoneNumber: false,
  },
  zemen: {
    image: true,
    sms: false,
    transactionNumber: true,
    transactionNumberHelper:
      "For Zemen: paste the receipt URL from share.zemenbank.com or the transaction reference.",
    requiresPhoneNumber: false,
  },
  "cbe-birr": {
    image: false,
    sms: false,
    transactionNumber: true,
    transactionNumberHelper:
      "For CBE Birr: paste the 10-character receipt number from your CBE Birr receipt.",
    requiresPhoneNumber: true,
  },
  mpesa: {
    image: false,
    sms: false,
    transactionNumber: true,
    transactionNumberHelper:
      "For M-Pesa: paste the receipt number from your M-Pesa confirmation.",
    requiresPhoneNumber: false,
  },
};

/**
 * Filter `types` to the set supported by `provider`. Returns the same shape
 * as the input array (label/icon pairs are stripped — only the values remain).
 */
export function supportedReceiptTypes(provider: Provider): ReceiptType[] {
  const caps = PROVIDER_CAPABILITIES[provider];
  const out: ReceiptType[] = [];
  if (caps.image) out.push("IMAGE");
  if (caps.sms) out.push("SMS_TEXT");
  if (caps.transactionNumber) out.push("TRANSACTION_NUMBER");
  return out;
}

/** True when the (provider, receiptType) combination is supported. */
export function isSupported(provider: Provider, receiptType: ReceiptType): boolean {
  const caps = PROVIDER_CAPABILITIES[provider];
  switch (receiptType) {
    case "IMAGE":
    case "SMS_SCREENSHOT":
      return caps.image;
    case "SMS_TEXT":
      return caps.sms;
    case "TRANSACTION_NUMBER":
      return caps.transactionNumber;
  }
}
