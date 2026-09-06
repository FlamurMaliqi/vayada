# Stage 1: Builder
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY . .
RUN npm ci
RUN npm run build --workspace=@vayada/domain-hotels

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_BOOKING_WEB_API_URL
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
ARG BOOKING_WEB_BUILD_SHA
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_BOOKING_WEB_API_URL=${NEXT_PUBLIC_BOOKING_WEB_API_URL}
ENV NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY}
ENV NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}
ENV BOOKING_WEB_BUILD_SHA=${BOOKING_WEB_BUILD_SHA}

WORKDIR /app/apps/booking-web
RUN npm run build

# Stage 2: Runner
FROM node:20-alpine AS runner
WORKDIR /app

ARG BOOKING_WEB_BUILD_SHA
ENV NODE_ENV=production
ENV BOOKING_WEB_BUILD_SHA=${BOOKING_WEB_BUILD_SHA}

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/booking-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/booking-web/.next/static ./apps/booking-web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/booking-web/public ./apps/booking-web/public

USER nextjs

EXPOSE 3002

ENV PORT=3002
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/booking-web/server.js"]
