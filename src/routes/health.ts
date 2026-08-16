/**
 * `GET /health` — liveness probe.
 *
 * Unauthenticated (Coolify and other orchestrators need to reach this
 * without a credential). Always returns 200 while the process is alive —
 * a rolling update must not be rolled back just because the dashboard is
 * briefly unreachable. Dashboard reachability is reported via the
 * `dashboardUp` / `status: "degraded"` fields instead. Queue depth checks
 * live on the dashboard side (it owns the tables), so this endpoint stays
 * cheap.
 */
import { Router, type Request, type Response } from "express";
import { log } from "../log.js";

const logv = log.child({ module: "health" });

export function healthRouter(): Router {
  const r = Router();

  r.get("/health", async (_req: Request, res: Response) => {
    let dashboardUp = false;
    try {
      const base = (process.env.DASHBOARD_URL ?? "").replace(/\/+$/, "");
      const token = process.env.WORKER_API_TOKEN ?? "";
      if (base && token) {
        const r2 = await fetch(`${base}/internal/worker/health-check`, {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2_000),
        });
        dashboardUp = r2.ok;
      }
    } catch (err) {
      logv.warn("dashboard health-check failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    res.status(200).json({
      status: dashboardUp ? "ok" : "degraded",
      service: "pygate-worker",
      dashboardUp,
      ranAt: new Date().toISOString(),
    });
  });

  return r;
}