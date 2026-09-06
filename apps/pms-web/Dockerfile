# Monorepo-aware Dockerfile.
# Build context is the repo root (workflow sets context: .).
# Workspace package @vayada/locale-constants is resolved from packages/.

# Stage 1: Builder
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy the monorepo. .dockerignore at root excludes node_modules, .next, etc.
COPY . .

# Workspace install resolves apps/* and packages/*.
RUN npm ci

# Accept build arguments for API URLs
ARG NEXT_PUBLIC_AUTH_API_URL
ARG NEXT_PUBLIC_PMS_API_URL
ARG NEXT_PUBLIC_PMS_OPERATIONS_API_URL
ARG NEXT_PUBLIC_PLATFORM_MEDIA_API_URL
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
ARG NEXT_PUBLIC_BOOKING_ADMIN_URL
ARG NEXT_PUBLIC_MARKETPLACE_URL
ARG NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED
ARG NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED
ENV NEXT_PUBLIC_AUTH_API_URL=${NEXT_PUBLIC_AUTH_API_URL}
ENV NEXT_PUBLIC_PMS_API_URL=${NEXT_PUBLIC_PMS_API_URL}
ENV NEXT_PUBLIC_PMS_OPERATIONS_API_URL=${NEXT_PUBLIC_PMS_OPERATIONS_API_URL}
ENV NEXT_PUBLIC_PLATFORM_MEDIA_API_URL=${NEXT_PUBLIC_PLATFORM_MEDIA_API_URL}
ENV NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}
ENV NEXT_PUBLIC_BOOKING_ADMIN_URL=${NEXT_PUBLIC_BOOKING_ADMIN_URL}
ENV NEXT_PUBLIC_MARKETPLACE_URL=${NEXT_PUBLIC_MARKETPLACE_URL}
ENV NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=${NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED}
ENV NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=${NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED}

# Build the application
# Booking builds its Hotels, PMS and Finance dependencies through prebuild.
RUN npm --workspace @vayada/domain-booking run build

WORKDIR /app/apps/pms-web
RUN npm run build

# Stage 2: Runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy necessary files from standalone build
COPY --from=builder --chown=nextjs:nodejs /app/apps/pms-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/pms-web/.next/static ./apps/pms-web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/pms-web/public ./apps/pms-web/public

USER nextjs

EXPOSE 3004

ENV PORT=3004
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/pms-web/server.js"]
