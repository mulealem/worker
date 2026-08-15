/**
 * Worker-side `/internal/webhook/deliver` — synchronous webhook
 * delivery for admin re-triggers / tests.
 *
 * The main path is the tick loop polling `webhook-deliveries/claim`. This
 * endpoint lets the dashboard push a specific delivery through immediately
 * (e.g. "re-deliver" button).
 *
 * Body: `{ deliveryId: string }` — the dashboard will hand the claim back
 * via `webhook-deliveries/claim` immediately after we acknowledge, so we
 * need to refetch the claim data here.
 */
import { Router } from "express";
import { z } from "zod";
import {
  claimNextWebhookDelivery,
  postWebhookResult,
} from "../dashboard-client.js";
import { deliverWebhook } from "../webhook/deliver.js";
import { log } from "../log.js";

const logv = log.child({ module: "webhook-deliver-route" });

const Body = z.object({ deliveryId: z.string().min(1) });

export const webhookRouter: Router = Router();

webhookRouter.post("/internal/webhook/deliver", async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const targetId = parsed.data.deliveryId;
  // Race the claim: loop until we get the row we want or until it doesn't
  // show up (e.g. another instance beat us to it).
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const claim = await claimNextWebhookDelivery();
    if (!claim) {
      res.status(404).json({ error: "No delivery available" });
      return;
    }
    if (claim.deliveryId !== targetId) {
      // Put it back so other instances / the next tick can pick it up.
      await postWebhookResult(claim.deliveryId, {
        finalStatus: "PENDING",
        lastError: "Race: this worker was asked to deliver a different ID",
        nextAttemptAt: new Date(Date.now() + 1_000).toISOString(),
        attempt: claim.attempt,
      });
      continue;
    }
    try {
      const outcome = await deliverWebhook({ claim });
      res.json({ ok: true, ...outcome });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logv.error(`deliver failed: ${msg}`);
      res.status(500).json({ error: msg });
      return;
    }
  }
  res.status(409).json({ error: "Could not claim that delivery within deadline" });
});
