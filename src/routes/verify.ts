/**
 * Worker-side `/api/v1/verify` and `/api/sandbox/verify`.
 *
 * Both endpoints accept EITHER:
 *   (a) multipart/form-data with a `receipt` file (customer upload flow).
 *   (b) JSON `{ reference, suffix?, phoneNumber? }` for the legacy
 *       reference-based lookup.
 *
 * Live payments are NOT auto-approved through these routes — only the
 * dashboard's `processVerificationResult` runs the DB transaction.
 */
import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import multer from "multer";
import { Buffer } from "node:buffer";
import {
  getProjectByApiKey,
  type ProjectByApiKey,
} from "../dashboard-client.js";
import {
  verifyPayment,
  shouldAutoApprove,
  type VerifiablePayment,
} from "../../lib/verifier/verify.js";
import type { BankType } from "../../lib/verifier/bank-type.js";
import { toMinor } from "../../lib/money.js";
import {
  runSmartVerify,
  type SmartVerifyOutcome,
} from "../../lib/verifier/universal.js";
import type { ReceiptData, VerifyResult } from "../../lib/verifier/types.js";
import { log } from "../log.js";

const logv = log.child({ module: "verify-route" });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const MultipartBody = z.object({
  receiptType: z
    .enum(["IMAGE", "SMS_TEXT", "SMS_SCREENSHOT", "TRANSACTION_NUMBER"])
    .optional(),
  transactionNumber: z.string().optional(),
  smsText: z.string().optional(),
  amount: z.coerce.number().optional(),
  currency: z.string().optional(),
  bankAccountId: z.string().optional(),
  phoneNumber: z.string().optional(),
  // Bank context sent by the sandbox form (SandboxForm.tsx). The sandbox
  // writes nothing to the DB, so client-supplied values are fine here —
  // they only steer provider routing and the informational eligibility
  // verdict.
  bankType: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  bankAccountName: z.string().optional(),
  expectedAmount: z.coerce.number().optional(),
});

const JsonBody = z.object({
  reference: z.string().min(1),
  suffix: z.string().optional(),
  phoneNumber: z.string().nullable().optional(),
});

interface ModeContext {
  mode: "live" | "sandbox";
}

function makeHandler(mode: ModeContext) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const apiKey = req.header("x-api-key") ?? req.header("x-pygate-api-key");
      if (!apiKey) {
        res.status(401).json({ error: "Missing x-api-key header" });
        return;
      }
      const project = await getProjectByApiKey(apiKey);
      logv.info("verify request received", { mode: mode.mode, projectId: project.id });

      const contentType = req.header("content-type") ?? "";
      if (contentType.includes("application/json")) {
        logv.debug("verify: dispatching JSON branch", { mode: mode.mode, projectId: project.id });
        return handleJson(req, res, project, mode);
      }
      logv.debug("verify: dispatching multipart branch", { mode: mode.mode, projectId: project.id });
      return handleMultipart(req, res, project, mode);
    } catch (err) {
      logv.error(
        `verify error: ${err instanceof Error ? err.message : String(err)}`,
      );
      next(err);
    }
  };
}

async function handleJson(
  req: Request,
  res: Response,
  project: ProjectByApiKey,
  mode: ModeContext,
): Promise<void> {
  const parsed = JsonBody.safeParse(req.body);
  if (!parsed.success) {
    logv.warn("verify JSON: invalid body", { mode: mode.mode, projectId: project.id });
    res.status(400).json({ error: "Invalid JSON body", details: parsed.error.format() });
    return;
  }
  logv.info(
    "verify JSON: running runSmartVerify",
    { mode: mode.mode, projectId: project.id, referencePrefix: parsed.data.reference.slice(0, 12) },
  );
  const outcome: SmartVerifyOutcome = await runSmartVerify({
    reference: parsed.data.reference,
    suffix: parsed.data.suffix ?? "",
    phoneNumber: parsed.data.phoneNumber ?? null,
  });
  if (!outcome.ok) {
    const status =
      outcome.status === 404 ? 404 : outcome.status === 401 ? 401 : 502;
    logv.warn(
      "verify JSON: runSmartVerify did not find a match",
      { mode: mode.mode, projectId: project.id, provider: outcome.provider, upstreamStatus: outcome.status, error: outcome.error },
    );
    res.status(status).json({
      ok: false,
      mode: mode.mode,
      project: { id: project.id, apiKey: project.apiKey },
      provider: outcome.provider,
      status: outcome.status,
      error: outcome.error,
    });
    return;
  }
  logv.info(
    "verify JSON: success",
    { mode: mode.mode, projectId: project.id, provider: outcome.provider, refId: outcome.data?.referenceId },
  );
  res.json({
    ok: true,
    mode: mode.mode,
    project: { id: project.id, apiKey: project.apiKey },
    provider: outcome.provider,
    data: serializeReceiptData(outcome.data),
  });
}

async function handleMultipart(
  req: Request,
  res: Response,
  project: ProjectByApiKey,
  mode: ModeContext,
): Promise<void> {
  const body = {
    ...(req.body ?? {}),
    receiptType:
      (req.body?.receiptType as string) ??
      (req.file ? "IMAGE" : "TRANSACTION_NUMBER"),
  };
  const parsed = MultipartBody.safeParse(body);
  if (!parsed.success) {
    logv.warn("verify multipart: invalid body", { mode: mode.mode, projectId: project.id });
    res.status(400).json({ error: "Invalid body", details: parsed.error.format() });
    return;
  }

  const receiptPath = getReceiptPath(req, parsed.data);
  if (!receiptPath) {
    logv.warn("verify multipart: missing receiptPath", { mode: mode.mode, projectId: project.id });
    res.status(400).json({
      error:
        "Provide either a file (multipart/form-data) or transactionNumber / smsText.",
    });
    return;
  }

  logv.info(
    "verify multipart: dispatching to verifyPayment",
    {
      mode: mode.mode,
      projectId: project.id,
      receiptType: parsed.data.receiptType ?? (req.file ? "IMAGE" : "TRANSACTION_NUMBER"),
      hasFile: !!req.file,
      hasPhoneNumber: !!parsed.data.phoneNumber,
    },
  );

  // Sandbox bank context: lets the verifier route to the right provider
  // (transaction-number / CBE-Birr phone lookups / OCR reference fallback)
  // and evaluate eligibility against the real account + expected amount.
  const sandboxBankAccount =
    parsed.data.bankType && parsed.data.bankAccountNumber
      ? {
          type: parsed.data.bankType as BankType,
          accountNumber: parsed.data.bankAccountNumber,
          accountName: parsed.data.bankAccountName ?? null,
          phoneNumber: parsed.data.phoneNumber ?? null,
        }
      : null;

  const verifiable: VerifiablePayment = {
    id: parsed.data.transactionNumber ?? parsed.data.smsText ?? receiptPath,
    receiptPath,
    receiptType: parsed.data.receiptType ?? "IMAGE",
    order: {
      id: "",
      amountMinor: 0,
      amount: parsed.data.amount ?? 0,
      currency: parsed.data.currency ?? "ETB",
      description: "",
      metadata: null,
    },
    bankAccount: sandboxBankAccount,
    phoneNumber: parsed.data.phoneNumber ?? null,
  };
  if (parsed.data.expectedAmount != null && Number.isFinite(parsed.data.expectedAmount)) {
    verifiable.order.amount = parsed.data.expectedAmount;
    verifiable.order.amountMinor = toMinor(parsed.data.expectedAmount) ?? 0;
  }
  if (req.file) {
    verifiable.readReceiptBytes = async () => req.file!.buffer;
  }

  const result = await verifyPayment(verifiable);

  let autoApproveEligible = false;
  let autoApproveReason: string | null = null;
  if (result.status === "VERIFIED" && result.data) {
    const verdict = shouldAutoApprove(
      verifiable.order.amountMinor,
      result.data,
      sandboxBankAccount,
    );
    autoApproveEligible = verdict.ok;
    autoApproveReason = verdict.reason ?? null;
  }

  logv.info(
    "verify multipart: returning sandbox verdict (no DB write)",
    {
      mode: mode.mode,
      projectId: project.id,
      status: result.status,
      refId: result.status === "VERIFIED" ? result.data?.referenceId : undefined,
      autoApproveEligible,
      autoApproveReason,
    },
  );

  res.json({
    mode: mode.mode,
    project: { id: project.id, apiKey: project.apiKey },
    result,
    autoApproveEligible,
    autoApproveReason,
  });
}

function getReceiptPath(
  req: Request,
  body: z.infer<typeof MultipartBody>,
): string | null {
  if (req.file) return req.file.originalname || "upload";
  if (body.receiptType === "TRANSACTION_NUMBER" && body.transactionNumber) {
    return body.transactionNumber;
  }
  if (
    (body.receiptType === "SMS_TEXT" || body.receiptType === "SMS_SCREENSHOT") &&
    body.smsText
  ) {
    return body.smsText;
  }
  return null;
}

function serializeReceiptData(d: ReceiptData): Record<string, unknown> {
  return {
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

export const verifyRouter: Router = Router();
// Paths here are relative to the mount point in server.ts (`/api/v1` and
// `/api/sandbox`). Express strips the mount prefix before delegating to this
// router, so the route paths inside must NOT include the prefix again.
verifyRouter.post(
  "/verify",
  upload.single("receipt"),
  makeHandler({ mode: "live" }),
);
verifyRouter.post(
  "/verify",
  upload.single("receipt"),
  makeHandler({ mode: "sandbox" }),
);
