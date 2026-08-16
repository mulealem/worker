# Deploy — worker (worker.payment.et)

PyGate worker — stateless compute service. OCR, QR, PDF, HMAC webhook
delivery. No Postgres, no R2, no schema. Push-driven: the dashboard
POSTs jobs and the worker calls back at
`/api/internal/worker/*` with a shared bearer token.

## Public URL

`https://worker.payment.et`

> The worker is bearer-token gated, but its public surface is still
> exposed. If you ever want to lock it down to Coolify's private
> network, set `DASHBOARD_URL` in the **dashboard** to the in-network
> URL instead and remove the public domain.

## Coolify resource

| Field | Value |
|---|---|
| Resource type | **Application** (Public) |
| Git repo | this monorepo |
| **Build Path** | `/worker` |
| **Port** | `3004` |
| **Healthcheck path** | `/health` |
| **Domain** | `worker.payment.et` |
| **Persistent volumes** | none |

## Full env-var checklist

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `PORT` | `3004` | |
| `DASHBOARD_URL` | `https://dashboard.payment.et` | **No trailing slash.** The worker calls back at this URL. |
| `WORKER_API_TOKEN` | *(same value as the dashboard's `WORKER_API_TOKEN`)* | 32-byte hex string. |
| `LOG_JSON` | `1` | Optional. JSON log lines for Coolify's log viewer. |
| `WORKER_HEARTBEAT_MS` | `10000` | Optional. Fire-and-forget heartbeats to the dashboard for observability. **State never lives here.** |

## First deploy

1. **The dashboard must already be deployed.** The worker's
   `dashboard-client.ts` throws on boot if `DASHBOARD_URL` or
   `WORKER_API_TOKEN` is missing, and its health probe
   (`/health`) returns 503 if it can't reach the dashboard.
2. Add the **Application** resource with the env vars above.
3. Deploy. The container:
   - `npm install --no-audit` (dev dependencies included — the Dockerfile
     overrides the build-time `NODE_ENV=production` for the install step)
   - `npm run build` (runs `tsc` → `dist/server.js`)
   - `node dist/server.js` on `:3004`
4. Test: visit `https://worker.payment.et/health` — expect
   `{"status":"ok","service":"pygate-worker","dashboardUp":true,…}`.

## Roll-forward

- **Token rotation** → generate a new `WORKER_API_TOKEN`, paste it into
  both the dashboard and the worker, redeploy both. No rotation
  ceremony needed — only one slot on each side.
- **`DASHBOARD_URL`** must match the dashboard's public URL exactly.
  When you move the dashboard, update this var too.
- **No migrations** — the worker has no schema.

## Operational notes

- Push-driven only. No `setInterval` polling on either side (dashboard ↔
  worker).
- On worker boot, it performs **one** GET against the dashboard to
  drain anything queued while it was down. After that, it idles until
  the dashboard pushes.
- `/health` always returns 200 if the process is alive, even if the
  dashboard is briefly unreachable — but with `dashboardUp: false`
  (503 in that case). Use this for the Coolify healthcheck.
