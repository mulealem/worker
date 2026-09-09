/**
 * HTTP client used by the worker to call the dashboard.
 *
 * The dashboard is the single source of truth for:
 *   - Receipt byte storage (R2 / local uploads)
 *   - VerifierJob + WebhookDelivery queues (Postgres)
 *   - Payment + Order + Project state
 *   - The auto-approve transaction (Drizzle)
 *
 * The worker has no Drizzle, no R2 credentials, no schema. Every read and
 * write goes through this client to one of the dashboard's authenticated
 * routes under `/api/internal/worker/...`.
 *
 * Auth: every request carries `Authorization: Bearer ${WORKER_API_TOKEN}`.
 * Timeouts default to 30s (verifier OCR can take a while); the health probe
 * uses a 2s timeout.
 */
import { log } from "./log.js";

const logv = log.child({ module: "dashboard-client" });

const baseUrl = (process.env.DASHBOARD_URL ?? "").replace(/\/+$/, "");
const token = process.env.WORKER_API_TOKEN ?? "";

if (!baseUrl || !token) {
  throw new Error(
    "DASHBOARD_URL and WORKER_API_TOKEN must be set in the worker's environment.",
  );
}

export class DashboardError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Dashboard returned ${status}`);
    this.name = "DashboardError";
    this.status = status;
    this.body = body;
  }
}

interface CallOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  expectStatus?: number;
  /** When true, the response body is treated as binary bytes (not JSON). */
  rawBytes?: boolean;
}

export async function callDashboard<T = unknown>(
  path: string,
  opts: CallOptions = {},
): Promise<T> {
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: opts.rawBytes ? "application/octet-stream" : "application/json",
  };
  const init: RequestInit = { method, headers, cache: "no-store" } as RequestInit;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, init);
  } catch (err) {
    throw new DashboardError(
      0,
      err instanceof Error ? err.message : String(err),
      "Dashboard unreachable",
    );
  } finally {
    clearTimeout(timer);
  }

  const expected = opts.expectStatus ?? 200;
  if (res.status !== expected) {
    const body = await res.text().catch(() => "");
    logv.warn(`dashboard returned ${res.status} (expected ${expected})`, { path, body: body.slice(0, 200) });
    throw new DashboardError(res.status, body);
  }

  if (res.status === 204) return undefined as T;
  if (opts.rawBytes) {
    return (new Uint8Array(await res.arrayBuffer())) as unknown as T;
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Typed wrappers per dashboard route
// ---------------------------------------------------------------------------

export interface PaymentContext {
  payment: {
    id: string;
    orderId: string;
    receiptPath: string;
    receiptType: "IMAGE" | "SMS_TEXT" | "SMS_SCREENSHOT" | "TRANSACTION_NUMBER";
    phoneNumber: string | null;
    bankAccountId: string | null;
    status: string;
  };
  order: {
    id: string;
    amountMinor: number;
    amount: number;
    currency: string;
    description: string;
    metadata: string | null;
  };
  project: {
    id: string;
    apiKey: string;
    callbackUrl: string;
  };
  bankAccount: {
    id: string;
    type: string;
    accountNumber: string;
    phoneNumber: string | null;
  } | null;
}

export function getPaymentContext(paymentId: string): Promise<PaymentContext> {
  return callDashboard<PaymentContext>(
    `/api/internal/worker/payments/${encodeURIComponent(paymentId)}/context`,
    { method: "GET" },
  );
}

export async function getReceiptBytes(filename: string): Promise<Buffer> {
  const u8 = await callDashboard<Uint8Array>(
    `/api/internal/worker/receipts/${encodeURIComponent(filename)}`,
    { method: "GET", rawBytes: true, timeoutMs: 60_000 },
  );
  return Buffer.from(u8);
}

export interface VerifierJobClaim {
  jobId: string;
  paymentId: string;
  attempts: number;
  maxAttempts: number;
}

export function claimNextVerifierJob(): Promise<VerifierJobClaim | null> {
  return callDashboard<VerifierJobClaim | null>(
    `/api/internal/worker/verifier-jobs/claim`,
    { method: "GET", expectStatus: 204 },
  ).catch((err: DashboardError) => {
    if (err.status === 204) return null;
    throw err;
  });
}

export function postVerifierResult(
  jobId: string,
  body: {
    status: "VERIFIED" | "UNVERIFIED" | "SKIPPED" | "ERROR";
    /** Omit to leave the Payment row untouched (job-row-only updates). */
    extractedData?: Record<string, unknown> | null;
    receiptReference?: string | null;
    lastError?: string | null;
  },
): Promise<{ ok: true }> {
  return callDashboard<{ ok: true }>(
    `/api/internal/worker/verifier-jobs/${encodeURIComponent(jobId)}/result`,
    { method: "POST", body },
  );
}

export function postVerifierRetry(
  jobId: string,
  body: { lastError: string },
): Promise<{ ok: true }> {
  return callDashboard<{ ok: true }>(
    `/api/internal/worker/verifier-jobs/${encodeURIComponent(jobId)}/retry`,
    { method: "POST", body },
  );
}

export function postVerifierFail(
  jobId: string,
  body: { lastError: string },
): Promise<{ ok: true }> {
  return callDashboard<{ ok: true }>(
    `/api/internal/worker/verifier-jobs/${encodeURIComponent(jobId)}/fail`,
    { method: "POST", body },
  );
}

export interface WebhookDeliveryClaim {
  deliveryId: string;
  paymentId: string;
  webhookId: string | null;
  url: string;
  payload: string;
  signature: string;
  idempotencyKey: string;
  attempt: number;
  maxAttempts: number;
  webhookUrl: string | null;
  webhookSigningSecret: string | null;
}

export function claimNextWebhookDelivery(): Promise<WebhookDeliveryClaim | null> {
  return callDashboard<WebhookDeliveryClaim | null>(
    `/api/internal/worker/webhook-deliveries/claim`,
    { method: "GET", expectStatus: 204 },
  ).catch((err: DashboardError) => {
    if (err.status === 204) return null;
    throw err;
  });
}

export function postWebhookResult(
  deliveryId: string,
  body: {
    finalStatus: "DONE" | "DEAD_LETTER" | "PENDING";
    statusCode?: number | null;
    lastError?: string | null;
    responseBody?: string | null;
    nextAttemptAt?: string | null;
    attempt?: number;
  },
): Promise<{ ok: true }> {
  return callDashboard<{ ok: true }>(
    `/api/internal/worker/webhook-deliveries/${encodeURIComponent(deliveryId)}/result`,
    { method: "POST", body },
  );
}

export interface AutoApproveResponse {
  ok: true;
  autoApproved: boolean;
  result: unknown;
}

export function postAutoApprove(
  paymentId: string,
  body: {
    status: "VERIFIED" | "UNVERIFIED" | "SKIPPED" | "ERROR";
    data: Record<string, unknown> | null;
    reason?: string | null;
  },
): Promise<AutoApproveResponse> {
  return callDashboard<AutoApproveResponse>(
    `/api/internal/worker/payments/${encodeURIComponent(paymentId)}/auto-approve`,
    { method: "POST", body, timeoutMs: 60_000 },
  );
}

export function postAudit(body: {
  action: string;
  actorUserId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}): Promise<{ ok: true }> {
  return callDashboard<{ ok: true }>(`/api/internal/worker/audit`, {
    method: "POST",
    body,
  });
}

/**
 * Mark a customer invoice as paid because its order just auto-approved.
 * Worker-side wrapper for the dashboard's mark-paid route.
 */
export function markInvoicePaid(orderId: string): Promise<{ ok: true }> {
  return callDashboard<{ ok: true }>(
    `/api/internal/worker/invoices/${encodeURIComponent(orderId)}/mark-paid`,
    { method: "POST" },
  );
}

/**
 * Look up a project by its API key — used by the sandbox route to translate
 * `x-pygate-api-key` into the canonical project record.
 */
export interface ProjectByApiKey {
  id: string;
  apiKey: string;
  callbackUrl: string;
  sandboxCallbackUrl: string | null;
  cbeBirrEnabled: boolean;
}
export function getProjectByApiKey(apiKey: string): Promise<ProjectByApiKey> {
  return callDashboard<ProjectByApiKey>(
    `/api/internal/worker/projects/by-api-key/${encodeURIComponent(apiKey)}`,
    { method: "GET" },
  );
}

/**
 * Fire-and-forget heartbeat from worker → dashboard. Purely observational.
 * The dashboard records a last-seen timestamp per worker; job state is
 * always pushed via `postVerifierResult` / `postVerifierRetry` / `postVerifierFail`.
 */
export function postHeartbeat(body: {
  pending: number;
  inFlight: number;
  uptimeSec: number;
}): Promise<{ ok: true }> {
  return callDashboard<{ ok: true }>(`/api/internal/worker/heartbeat`, {
    method: "POST",
    body,
    // Short timeout — heartbeats must never block the executor.
    timeoutMs: 5_000,
  });
}
