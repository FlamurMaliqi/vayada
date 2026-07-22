# Monorepo-aware Dockerfile.
# Build context is the repo root (workflow sets context: .).
# Workspace package @vayada/marketplace-shared is resolved from packages/.

# Stage 1: Builder
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy the monorepo. .dockerignore at root excludes node_modules, .next, etc.
COPY . .

# Workspace install — resolves apps/*, packages/*, and docs.
RUN npm ci

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ARG NEXT_PUBLIC_AUTH_API_URL
ENV NEXT_PUBLIC_AUTH_API_URL=${NEXT_PUBLIC_AUTH_API_URL}
ARG NEXT_PUBLIC_VAYADA_API_URL
ENV NEXT_PUBLIC_VAYADA_API_URL=${NEXT_PUBLIC_VAYADA_API_URL}
ARG NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED
ENV NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=${NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED}
ARG NEXT_PUBLIC_PLATFORM_MEDIA_API_URL
ENV NEXT_PUBLIC_PLATFORM_MEDIA_API_URL=${NEXT_PUBLIC_PLATFORM_MEDIA_API_URL}
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
ENV NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}
ARG NEXT_PUBLIC_PMS_URL
ENV NEXT_PUBLIC_PMS_URL=${NEXT_PUBLIC_PMS_URL}
ARG NEXT_PUBLIC_BOOKING_ADMIN_URL
ENV NEXT_PUBLIC_BOOKING_ADMIN_URL=${NEXT_PUBLIC_BOOKING_ADMIN_URL}
ARG NEXT_PUBLIC_MARKETPLACE_URL
ENV NEXT_PUBLIC_MARKETPLACE_URL=${NEXT_PUBLIC_MARKETPLACE_URL}

WORKDIR /app/apps/marketplace-web
RUN npm run build

# Stage 2: Runner — Next.js standalone output
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# In a workspace setup the standalone output is rooted at the monorepo,
# with server.js at apps/marketplace-web/server.js.
COPY --from=builder --chown=nextjs:nodejs /app/apps/marketplace-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/marketplace-web/.next/static ./apps/marketplace-web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/marketplace-web/public ./apps/marketplace-web/public

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/marketplace-web/server.js"]
