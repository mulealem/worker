# pygate/worker

Stateless compute service for the PyGate stack. Owns the OCR/QR/PDF/HTML
parsers, the HMAC webhook signing, and the **push-driven** job executor.
Has **no Drizzle client, no R2 credentials, and no schema files** — every
read and write goes over HTTP to the dashboard.

> **No polling for work.** The dashboard pushes job notifications to this
> service at `POST /internal/dispatch/jobs`. Results are pushed back via
> `postVerifierResult` / `postVerifierRetry` / `postVerifierFail`. The
> only one-shot reconciliation is a single GET on worker boot.

## Why

The dashboard's verifier queue, webhook delivery queue, and `/api/v1/verify`
endpoint are too heavy for Vercel's serverless runtime (long-running
`setInterval`, large native modules, persistent outbound connections).
Splitting them into a long-lived Node process on a separate Coolify app
keeps the dashboard deployable to Vercel while the worker runs as a
classical process on the same VPS.

## Architecture

```
   checkout ─► dashboard (Drizzle + R2 + auth) ─► worker (this repo)
                                                       │
                                                       │ HTTP callbacks
                                                       ▼
                                                  dashboard
                                                  (writes back to DB)
```

The worker's executor idles on a wakeable promise. When the dashboard
pushes a new job, the executor wakes and runs it. On boot, the worker
performs a **single** GET against the dashboard's claim endpoint to pick
up anything that was enqueued while it was offline — this is a one-shot
recovery, NOT a polling loop. The dashboard remains the single source of
truth for every row in the database.

### Push contract

- Dashboard → worker: `POST /internal/dispatch/jobs` with
  `{ jobId, paymentId, attempts, maxAttempts, idempotencyKey? }`. The
  worker returns `202` + `{ accepted, deduped }`.
- Worker → dashboard: `postVerifierResult` / `postVerifierRetry` /
  `postVerifierFail` (existing). State lives in the dashboard DB.
- Worker → dashboard: optional fire-and-forget heartbeat to
  `POST /api/internal/worker/heartbeat`. Observability only — never a
  source of truth.
- On boot: `GET /internal/dispatch/pending` (single call, capped at
  500 jobs per round). Seeded jobs are pushed into the in-memory queue.

## Running locally

```bash
cp .env.example .env
# fill in WORKER_API_TOKEN (openssl rand -hex 32) and DASHBOARD_URL
npm install
npm run dev          # http://localhost:3004
curl http://localhost:3004/health
```

The dashboard must be running on the URL pointed to by `DASHBOARD_URL` and
must be configured with the same `WORKER_API_TOKEN` (in its `BACKEND_API_TOKENS`
allow-list — see the dashboard's `internal-api-auth-worker.ts`).

## Deploy

Coolify, second app in the same project as the dashboard:

1. Source: this `worker/` folder
2. Build pack: Dockerfile
3. Port: 3004
4. Environment: `WORKER_API_TOKEN` (shared with dashboard), `DASHBOARD_URL`
   (e.g. `http://dashboard:3000` on the Coolify network), `PORT=3004`

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | — | Liveness + dashboard reachability check |
| `POST` | `/internal/verifier/run` | bearer | Enqueue a verifier job (async) |
| `POST` | `/internal/verifier/run-sync` | bearer | Run verifier synchronously (used by tryAutoPay) |
| `POST` | `/internal/webhook/deliver` | bearer | Enqueue a webhook delivery (async) |
| `POST` | `/api/v1/verify` | x-api-key | Public REST verify (project lookup) |
| `POST` | `/api/sandbox/verify` | bearer | Admin-only verify with synthetic order |

The `/api/*` routes accept JSON; receipt upload from the dashboard is
plain `POST /internal/verifier/run { paymentId }` (the dashboard already
uploaded the bytes to R2 before calling).

## Code ownership

| Lives here | Lives on the dashboard |
|---|---|
| `src/verifier/**` (24 files) | `db/schema/**` |
| `src/receipts/validate.ts` | `db/migrate.ts` |
| `src/ssrf.ts` | `lib/db.ts` (Drizzle client) |
| `src/workers/tick.ts` (setInterval) | `lib/storage.ts` (R2 + local) |
| `src/routes/**` (HTTP surface) | `app/api/internal/worker/**` (callback API) |
| `src/auth.ts` (bearer check) | `lib/internal-api-auth-worker.ts` |

The worker has zero knowledge of the data layer.

## License

Proprietary — internal PyGate code.
