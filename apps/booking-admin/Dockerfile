# Monorepo-aware Dockerfile.
# Build context is the repo root (workflow sets context: .).
# Workspace package @vayada/product-onboarding is resolved from packages/.

# Stage 1: Builder
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy the monorepo. .dockerignore at root excludes node_modules, .next, etc.
COPY . .

# Workspace install — resolves apps/*, packages/*, and docs.
RUN npm ci
RUN npm --workspace @vayada/domain-hotels run build

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_AUTH_API_URL
ARG NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED
ARG NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED
ARG NEXT_PUBLIC_PLATFORM_MEDIA_API_URL
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
ARG NEXT_PUBLIC_PMS_URL
ARG NEXT_PUBLIC_PMS_FRONTEND_URL
ARG NEXT_PUBLIC_MARKETPLACE_URL
ARG NEXT_PUBLIC_BOOKING_URL_TEMPLATE
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_AUTH_API_URL=${NEXT_PUBLIC_AUTH_API_URL}
ENV NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=${NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED}
ENV NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=${NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED}
ENV NEXT_PUBLIC_PLATFORM_MEDIA_API_URL=${NEXT_PUBLIC_PLATFORM_MEDIA_API_URL}
ENV NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}
ENV NEXT_PUBLIC_PMS_URL=${NEXT_PUBLIC_PMS_URL}
ENV NEXT_PUBLIC_PMS_FRONTEND_URL=${NEXT_PUBLIC_PMS_FRONTEND_URL}
ENV NEXT_PUBLIC_MARKETPLACE_URL=${NEXT_PUBLIC_MARKETPLACE_URL}
ENV NEXT_PUBLIC_BOOKING_URL_TEMPLATE=${NEXT_PUBLIC_BOOKING_URL_TEMPLATE}

WORKDIR /app/apps/booking-admin
RUN npm run build

# Stage 2: Runner — Next.js standalone output
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Standalone is rooted at the monorepo; server.js sits at apps/<name>/server.js.
COPY --from=builder --chown=nextjs:nodejs /app/apps/booking-admin/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/booking-admin/.next/static ./apps/booking-admin/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/booking-admin/public ./apps/booking-admin/public

USER nextjs

EXPOSE 3003

ENV PORT=3003
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/booking-admin/server.js"]
