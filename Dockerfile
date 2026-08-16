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
# Coolify injects NODE_ENV=production into the build environment, which makes
# npm skip devDependencies (typescript, @types/*, ...) that the builder needs
# below. Force a development install in this stage.
ENV NODE_ENV=development
COPY package.json package-lock.json* ./
RUN npm install --no-audit

FROM base AS prod-deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit && npm cache clean --force

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
COPY lib ./lib
RUN npm run build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3004
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 worker

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY package.json ./

USER worker
EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-3004}/health || exit 1

# tsconfig rootDir is ".", so tsc emits src/ and lib/ under dist/.
CMD ["node", "dist/src/server.js"]
