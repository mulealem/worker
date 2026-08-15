/**
 * Worker-side verifier runner.
 *
 * Pipeline:
 *   1. Fetch the payment context from the dashboard
 *   2. Fetch receipt bytes from the dashboard's receipts endpoint
 *   3. Run `verifyPayment(...)` (the same code the dashboard uses)
 *   4. POST the result to the dashboard's verifier-jobs result endpoint
 *   5. If the verdict is VERIFIED + passes the auto-approve gate, call the
 *      dashboard's auto-approve endpoint so the dashboard can run the
 *      transaction that flips Payment + Order + fires the webhook.
 *
 * The worker never touches the DB. If auto-approve fails (e.g. duplicate
 * reference), the dashboard tells us why and we surface it back to the
 * admin via the verifier log.
 */
import { Buffer } from "node:buffer";
import {
  getPaymentContext,
  getReceiptBytes,
  postAutoApprove,
  postAudit,
  postVerifierResult,
  type PaymentContext,
} from "../dashboard-client.js";
import {
  verifyPayment,
  shouldAutoApprove,
  type VerifiablePayment,
  type Order,
  type BankAccount,
} from "../../lib/verifier/verify.js";
import type { ReceiptData, VerifyResult } from "../../lib/verifier/types.js";
import { log } from "../log.js";

const logv = log.child({ module: "verifier-run" });

function toOrderShape(ctx: PaymentContext): Order {
  return {
    id: ctx.order.id,
    amountMinor: ctx.order.amountMinor,
    amount: ctx.order.amount,
    currency: ctx.order.currency,
    description: ctx.order.description,
    metadata: ctx.order.metadata,
  };
}

function toBankAccountShape(
  ctx: PaymentContext,
): Pick<BankAccount, "type" | "accountNumber" | "phoneNumber"> | null {
  if (!ctx.bankAccount) return null;
  return {
    type: ctx.bankAccount.type as BankAccount["type"],
    accountNumber: ctx.bankAccount.accountNumber,
    phoneNumber: ctx.bankAccount.phoneNumber,
  };
}

export interface RunVerifierArgs {
  jobId: string;
  paymentId: string;
}

export interface RunVerifierOutcome {
  result: VerifyResult;
  autoApproved: boolean;
}

export async function runVerifierJob(
  args: RunVerifierArgs,
): Promise<RunVerifierOutcome> {
  const { jobId, paymentId } = args;

  logv.info(`starting job=${jobId} paymentId=${paymentId}`);

  const ctx = await getPaymentContext(paymentId);
  logv.info(`loaded context payment.status=${ctx.payment.status}`);

  if (ctx.payment.status !== "PENDING") {
    logv.info(
      `payment ${paymentId} is ${ctx.payment.status}, no work to do`,
    );
    await postVerifierResult(jobId, {
      status: "SKIPPED",
      extractedData: null,
      receiptReference: null,
      lastError: null,
    });
    return {
      result: { status: "SKIPPED", reason: "payment not pending" },
      autoApproved: false,
    };
  }

  const byteFetcher = async (filename: string): Promise<Buffer> => {
    return await getReceiptBytes(filename);
  };

  const verifiable: VerifiablePayment = {
    id: ctx.payment.id,
    receiptPath: ctx.payment.receiptPath,
    receiptType: ctx.payment.receiptType,
    order: toOrderShape(ctx),
    bankAccount: toBankAccountShape(ctx),
    phoneNumber: ctx.payment.phoneNumber ?? ctx.bankAccount?.phoneNumber ?? null,
    readReceiptBytes: byteFetcher,
  };

  const result = await verifyPayment(verifiable);
  logv.info(
    `verifyPayment done status=${result.status} ` +
      `reason=${"reason" in result ? result.reason : "<none>"}`,
  );

  // Extract the bits we want to persist on the Payment row.
  const extractedData: Record<string, unknown> | null =
    "data" in result && result.data
      ? (result.data as unknown as Record<string, unknown>)
      : null;
  const receiptReference: string | null =
    "data" in result && result.data
      ? ((result.data as ReceiptData).referenceId ?? null)
      : null;

  await postVerifierResult(jobId, {
    status: result.status,
    extractedData,
    receiptReference,
    lastError: "reason" in result ? result.reason ?? null : null,
  });

  // Auto-approve: dashboard owns the transaction.
  let autoApproved = false;
  if (result.status === "VERIFIED" && result.data) {
    const verdict = shouldAutoApprove(
      ctx.order.amountMinor,
      result.data,
      ctx.bankAccount
        ? {
            type: ctx.bankAccount.type as BankAccount["type"],
            accountNumber: ctx.bankAccount.accountNumber,
          }
        : null,
    );
    if (verdict.ok) {
      logv.info(
        `auto-approve eligible payment=${paymentId} refId=${result.data.referenceId}`,
      );
      try {
        const resp = await postAutoApprove(paymentId, {
          status: "VERIFIED",
          data: result.data as unknown as Record<string, unknown>,
        });
        autoApproved = resp.autoApproved;
        logv.info(
          `auto-approve response payment=${paymentId} autoApproved=${autoApproved}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logv.warn(`auto-approve failed payment=${paymentId} reason=${msg}`);
        try {
          await postAudit({
            action: "auto_approve_failed",
            entityType: "Payment",
            entityId: paymentId,
            after: { error: msg },
            correlationId: jobId,
          });
        } catch {
          /* audit is best-effort */
        }
      }
    } else {
      logv.info(
        `auto-approve denied payment=${paymentId} reason=${verdict.reason}`,
      );
    }
  }

  return { result, autoApproved };
}
