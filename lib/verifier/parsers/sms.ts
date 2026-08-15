/**
 * SMS/OCR text URL extractor. Re-exports `findBankUrl` for symmetry with the
 * parser directory layout. Higher-level "try to extract a ReceiptData from a
 * free-text blob without going through the URL" is intentionally not provided
 * here — Ethiopian bank SMS templates are not standardized enough to extract
 * transaction data reliably without the URL, so we just surface "no URL" and
 * let `verify.ts` return SKIPPED.
 */

export { findBankUrl } from "../detector.js";
