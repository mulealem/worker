/**
 * `POST /internal/scan-verify` — stateless QR verification for the mobile app.
 *
 * The merchant scans a QR code in the field and the raw payload lands here:
 *   - Bank receipt URL (e.g. a CBE app receipt QR encoding
 *     `https://mbreciept.cbe.com.et/?id=FT...`) → the same `verifyFromUrl`
 *     pipeline the verifier jobs use fetches the receipt from the bank and
 *     parses it. Result goes straight back to the caller.
 *   - ETHQR (NBE interoperable) payload → decoded + CRC-validated locally.
 *   - Legacy closed-loop QR (bare Telebirr-style till digits) → recognized
 *     but not verifiable.
 *
 * Nothing is persisted: no VerifierJob, no DB row, no receipt bytes — the
 * endpoint exists purely to answer "what is this QR and does it check out".
 * This route never auto-approves anything; it has no order context by design.
 */
import { Router } from "express";
import { z } from "zod";
import { findBankUrl } from "../../lib/verifier/detector.js";
import { decodeQrPayload, type EthQrDecoded } from "../../lib/verifier/ethqr.js";
import { verifyFromUrl } from "../../lib/verifier/verify.js";
import type { ReceiptData } from "../../lib/verifier/types.js";
import { log } from "../log.js";

const logv = log.child({ module: "scan-verify-route" });

const ScanBody = z.object({
  payload: z.string().min(4).max(2048),
});

function serializeReceiptData(d: ReceiptData): Record<string, unknown> {
  return {
    provider: d.provider,
    referenceId: d.referenceId,
    amount: d.amount,
    currency: d.currency,
    paymentDate: d.paymentDate,
    payerName: d.payerName,
    payerAccount: d.payerAccount,
    payerPhone: d.payerPhone,
    receiverName: d.receiverName,
    receiverAccount: d.receiverAccount,
    receiverBank: d.receiverBank,
    serviceFee: d.serviceFee,
    vat: d.vat,
    totalPaid: d.totalPaid,
    transactionType: d.transactionType,
    paymentMode: d.paymentMode,
    paymentReason: d.paymentReason,
    paymentChannel: d.paymentChannel,
    narrative: d.narrative,
    extractionMethod: d.extractionMethod,
  };
}

function serializeEthQr(d: EthQrDecoded): Record<string, unknown> {
  return {
    crcValid: d.crcValid,
    payloadFormatIndicator: d.payloadFormatIndicator,
    pointOfInitiation: d.pointOfInitiation,
    merchantCategoryCode: d.merchantCategoryCode,
    currency: d.currency,
    amount: d.amount,
    merchantName: d.merchantName,
    merchantCity: d.merchantCity,
    referenceLabel: d.referenceLabel,
    purposeOfTransaction: d.purposeOfTransaction,
    mai28: d.mai28
      ? { guid: d.mai28.guid, bic: d.mai28.bic, accountNumber: d.mai28.accountNumber }
      : null,
  };
}

async function handle(req: import("express").Request, res: import("express").Response): Promise<void> {
  const parsed = ScanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", code: "invalid_payload" });
    return;
  }
  const payload = parsed.data.payload.trim();
  logv.info(`scan-verify payloadLen=${payload.length}`);

  // 1. Bank receipt URL — fetch + parse from the bank, nothing stored.
  const urlHit = findBankUrl(payload);
  if (urlHit) {
    logv.info(`scan-verify bank URL provider=${urlHit.provider}`);
    try {
      const data = await verifyFromUrl(urlHit.url, urlHit.provider);
      if (data && data.referenceId) {
        res.json({ ok: true, kind: "bank_receipt", provider: urlHit.provider, receipt: serializeReceiptData(data) });
        return;
      }
      res.status(502).json({
        ok: false,
        kind: "bank_receipt",
        provider: urlHit.provider,
        code: "receipt_unparsable",
        error: "The bank acknowledged the receipt but its details could not be parsed.",
      });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logv.warn(`scan-verify bank fetch failed: ${msg}`);
      res.status(502).json({
        ok: false,
        kind: "bank_receipt",
        provider: urlHit.provider,
        code: "bank_unreachable",
        error: msg.slice(0, 300),
      });
      return;
    }
  }

  // 2. ETHQR / EMVCo-style TLV payload (interoperable merchant QR).
  const decoded = decodeQrPayload(payload);
  if (decoded.kind === "ethqr") {
    logv.info(
      `scan-verify ethqr crcValid=${decoded.decoded.crcValid} ` +
        `bic=${decoded.decoded.mai28?.bic ?? "<none>"}`,
    );
    res.json({ ok: true, kind: "ethqr", ethqr: serializeEthQr(decoded.decoded) });
    return;
  }
  if (decoded.kind === "legacy_till") {
    res.json({
      ok: true,
      kind: "legacy_till",
      code: "closed_loop_qr",
      error:
        "This is a legacy closed-loop QR (a till number). It can only be paid inside that provider's own app, so it can't be verified here.",
    });
    return;
  }

  res.json({ ok: true, kind: "unknown", code: "unrecognized_qr" });
}

export const scanVerifyRouter: Router = Router();
scanVerifyRouter.post("/scan-verify", (req, res) => {
  void handle(req, res);
});
