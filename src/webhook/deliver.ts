/**
 * Worker-side webhook delivery.
 *
 * Pipeline:
 *   1. Dashboard hands us a `WebhookDelivery` row (already claimed atomically)
 *   2. Optionally re-sign the body with the linked Webhook's signing secret
 *      (HMAC-SHA256, same scheme as the dashboard's outbound webhook)
 *   3. POST to the delivery URL with timeout + idempotency-key header
 *   4. POST the outcome back to the dashboard:
 *      - 2xx → DONE
 *      - non-2xx and attempts < maxAttempts → PENDING, schedule next attempt
 *      - non-2xx and attempts >= maxAttempts → DEAD_LETTER
 *
 * Backoff schedule: 5s, 15s, 45s, 5m (matches the dashboard's previous
 * behaviour). The worker schedules `nextAttemptAt` and the dashboard simply
 * respects that timestamp on the next claim.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  postWebhookResult,
  type WebhookDeliveryClaim,
} from "../dashboard-client.js";
import { log } from "../log.js";

const logv = log.child({ module: "webhook-deliver" });

const BACKOFF_MS = [5_000, 15_000, 45_000, 300_000];

/**
 * Sign `body` with `secret` using the same scheme as the dashboard:
 *   signature = "sha256=" + hex(HMAC_SHA256(secret, body))
 *
 * Returns `null` if the inputs don't make sense (no secret, no body).
 */
function signBody(body: string, secret: string | null): string | null {
  if (!secret || !body) return null;
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function nextAttemptDelayMs(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[idx]!;
}

export interface DeliverWebhookArgs {
  claim: WebhookDeliveryClaim;
}

export interface DeliverWebhookOutcome {
  finalStatus: "DONE" | "DEAD_LETTER" | "PENDING";
  statusCode?: number;
  lastError?: string | null;
  responseBody?: string;
  attempt: number;
}

export async function deliverWebhook(
  args: DeliverWebhookArgs,
): Promise<DeliverWebhookOutcome> {
  const { claim } = args;
  const attempt = claim.attempt + 1;

  const url = claim.webhookUrl ?? claim.url;
  const signingSecret = claim.webhookSigningSecret;

  // Re-sign when the original delivery was wired to a Webhook subscription
  // (so the merchant's signatures stay valid even if the secret rotated).
  // Otherwise the original signature travels through unchanged.
  const signature =
    signingSecret && claim.webhookUrl
      ? signBody(claim.payload, signingSecret) ?? claim.signature
      : claim.signature;

  logv.info(
    `delivery attempt=${attempt}/${claim.maxAttempts} url=${url} ` +
      `deliveryId=${claim.deliveryId}`,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let statusCode: number;
  let responseBody: string;
  let lastError: string | null = null;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pygate-delivery-id": claim.deliveryId,
        "x-pygate-idempotency-key": claim.idempotencyKey,
        "x-pygate-signature": signature,
        "x-pygate-attempt": String(attempt),
      },
      body: claim.payload,
      signal: controller.signal,
    });
    statusCode = res.status;
    responseBody = await res.text().catch(() => "");
  } catch (err) {
    statusCode = 0;
    responseBody = "";
    lastError = err instanceof Error ? err.message : String(err);
    logv.warn(
      `delivery failed deliveryId=${claim.deliveryId} reason=${lastError}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const ok = statusCode >= 200 && statusCode < 300;
  if (ok) {
    logv.info(
      `delivery OK deliveryId=${claim.deliveryId} status=${statusCode}`,
    );
    await postWebhookResult(claim.deliveryId, {
      finalStatus: "DONE",
      statusCode,
      lastError: null,
      responseBody: responseBody.slice(0, 4096),
      attempt,
    });
    return {
      finalStatus: "DONE",
      statusCode,
      lastError: null,
      responseBody: responseBody.slice(0, 4096),
      attempt,
    };
  }

  const dead = attempt >= claim.maxAttempts;
  if (dead) {
    logv.warn(
      `delivery DEAD_LETTER deliveryId=${claim.deliveryId} status=${statusCode} ` +
        `reason=${lastError ?? "<non-2xx>"}`,
    );
    await postWebhookResult(claim.deliveryId, {
      finalStatus: "DEAD_LETTER",
      statusCode,
      lastError: lastError ?? `HTTP ${statusCode}`,
      responseBody: responseBody.slice(0, 4096),
      attempt,
    });
    return {
      finalStatus: "DEAD_LETTER",
      statusCode,
      lastError: lastError ?? `HTTP ${statusCode}`,
      responseBody: responseBody.slice(0, 4096),
      attempt,
    };
  }

  const nextAttemptAt = new Date(Date.now() + nextAttemptDelayMs(attempt));
  logv.info(
    `delivery PENDING deliveryId=${claim.deliveryId} status=${statusCode} ` +
      `nextAttemptAt=${nextAttemptAt.toISOString()}`,
  );
  await postWebhookResult(claim.deliveryId, {
    finalStatus: "PENDING",
    statusCode,
    lastError: lastError ?? `HTTP ${statusCode}`,
    responseBody: responseBody.slice(0, 4096),
    nextAttemptAt: nextAttemptAt.toISOString(),
    attempt,
  });
  return {
    finalStatus: "PENDING",
    statusCode,
    lastError: lastError ?? `HTTP ${statusCode}`,
    responseBody: responseBody.slice(0, 4096),
    attempt,
  };
}

/** Same constant-time compares as the dashboard. Only used for tests. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
