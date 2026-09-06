# Monorepo-aware Dockerfile.
# Build context is the repo root (workflow sets context: .).
# Workspace package @vayada/marketplace-shared is resolved from packages/.

# Stage 1: Builder
FROM node:24-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY . .

RUN npm ci

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ARG NEXT_PUBLIC_VAYADA_API_URL
ENV NEXT_PUBLIC_VAYADA_API_URL=${NEXT_PUBLIC_VAYADA_API_URL}

ARG NEXT_PUBLIC_CLOUDFLARE_ANALYTICS_TOKEN
ENV NEXT_PUBLIC_CLOUDFLARE_ANALYTICS_TOKEN=${NEXT_PUBLIC_CLOUDFLARE_ANALYTICS_TOKEN}

WORKDIR /app/apps/landing
RUN npm run build

# Stage 2: Runner — Next.js standalone output
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/landing/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/landing/.next/static ./apps/landing/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/landing/public ./apps/landing/public

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/landing/server.js"]
