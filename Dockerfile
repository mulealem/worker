# syntax=docker/dockerfile:1
#
# PyGate worker — stateless compute service (OCR / QR / PDF / HMAC webhooks).
# No DATABASE_URL, no R2 credentials, no schema. Push-driven: the dashboard
# POSTs jobs and the worker calls back via /api/internal/worker/* with the
# shared WORKER_API_TOKEN.

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

FROM base AS builder
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3004
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 worker

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY package.json ./

USER worker
EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3004}/health || exit 1

CMD ["node", "dist/server.js"]
