# Monorepo build context: npm resolves shared workspace packages locally.
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY . .
RUN npm ci

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

ARG NEXT_PUBLIC_AUTH_API_URL
ENV NEXT_PUBLIC_AUTH_API_URL=${NEXT_PUBLIC_AUTH_API_URL}

ARG NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED
ENV NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=${NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED}

WORKDIR /app/apps/affiliate-dashboard
RUN npm run build

# Stage 3: Runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/affiliate-dashboard/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/affiliate-dashboard/.next/static ./apps/affiliate-dashboard/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/affiliate-dashboard/public ./apps/affiliate-dashboard/public

USER nextjs

EXPOSE 3005

ENV PORT=3005
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/affiliate-dashboard/server.js"]
