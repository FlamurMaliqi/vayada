import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import pg from "pg";

export type BookingWebAffiliateHotelResolver = {
  findProfileBySlug(slug: string): Promise<unknown | null>;
  close?(): Promise<void>;
};

type BookingWebAffiliateHotelParams = {
  slug: string;
};

type BookingWebAffiliateParams = BookingWebAffiliateHotelParams & {
  affiliateId: string;
};

type BookingWebAffiliateEmailQuery = {
  email?: string;
};

export type BookingWebAffiliateRegistrationRequest = {
  fullName?: string;
  email?: string;
  socialMedia?: string;
  userType?: "guest" | "creator" | string;
  paymentMethod?: "stripe" | "paypal" | "bank" | string;
};

export type BookingWebAffiliateStripeConnectRequest = {
  email?: string;
};

export type BookingWebAffiliateRegistrationResult = {
  id: string;
  referralCode: string;
};

export type BookingWebAffiliateStripeConnectResult = {
  onboardingUrl: string;
};

export type BookingWebAffiliateStripeConnectProvider = {
  createAffiliateOnboardingLink(input: {
    affiliateId: string;
    email: string;
    idempotencyKey: string;
    slug: string;
  }): Promise<{
    onboardingUrl: string;
    providerAccountId: string;
  }>;
};

export type BookingWebAffiliateRepository = {
  checkEmail(slug: string, email: string): Promise<{ exists: boolean }>;
  register(
    slug: string,
    request: BookingWebAffiliateRegistrationRequest,
  ): Promise<BookingWebAffiliateRegistrationResult>;
  createStripeConnectLink(
    slug: string,
    affiliateId: string,
    request: BookingWebAffiliateStripeConnectRequest,
  ): Promise<BookingWebAffiliateStripeConnectResult>;
};

export type BookingWebAffiliateRoutesOptions = {
  hotelResolver: BookingWebAffiliateHotelResolver;
  repository: BookingWebAffiliateRepository;
};

export async function registerBookingWebAffiliateRoutes(
  app: FastifyInstance,
  options: BookingWebAffiliateRoutesOptions,
): Promise<void> {
  app.addHook("onClose", async () => {
    await options.hotelResolver.close?.();
  });

  app.get<{
    Params: BookingWebAffiliateHotelParams;
    Querystring: BookingWebAffiliateEmailQuery;
  }>("/hotels/:slug/affiliates/check-email", async (request, reply) => {
    await assertHotelExists(options.hotelResolver, request.params.slug);
    const email = normalizeEmail(request.query.email);
    if (!email) {
      throw createHttpError(400, "Email is required.");
    }

    const response = await options.repository.checkEmail(request.params.slug, email);
    reply.header("Cache-Control", "no-store");
    reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-affiliate-check-email");
    reply.header("X-Robots-Tag", "noindex");
    return response;
  });

  app.post<{
    Params: BookingWebAffiliateHotelParams;
    Body: BookingWebAffiliateRegistrationRequest;
  }>("/hotels/:slug/affiliates", async (request, reply) => {
    await assertHotelExists(options.hotelResolver, request.params.slug);
    const body = request.body ?? {};
    const email = normalizeEmail(body.email);
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    if (!email) {
      throw createHttpError(400, "Email is required.");
    }
    if (!fullName) {
      throw createHttpError(400, "Full name is required.");
    }

    const response = await options.repository.register(request.params.slug, {
      ...body,
      email,
      fullName,
    });
    reply.header("Cache-Control", "no-store");
    reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-affiliate-register");
    reply.header("X-Robots-Tag", "noindex");
    return response;
  });

  app.post<{
    Params: BookingWebAffiliateParams;
    Body: BookingWebAffiliateStripeConnectRequest;
  }>("/hotels/:slug/affiliates/:affiliateId/stripe/connect", async (request, reply) => {
    await assertHotelExists(options.hotelResolver, request.params.slug);
    const email = normalizeEmail(request.body?.email);
    if (!email) {
      throw createHttpError(400, "Email is required.");
    }
    const response = await options.repository.createStripeConnectLink(
      request.params.slug,
      request.params.affiliateId,
      { ...request.body, email },
    );
    reply.header("Cache-Control", "no-store");
    reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-affiliate-stripe-connect");
    reply.header("X-Robots-Tag", "noindex");
    return response;
  });
}

type PgBookingWebAffiliateRepositoryConfig = {
  connectionString: string;
  max?: number;
  now?: () => Date;
  stripeConnectProvider?: BookingWebAffiliateStripeConnectProvider;
  pool?: pg.Pool;
};

export function createPgBookingWebAffiliateRepository(
  config: PgBookingWebAffiliateRepositoryConfig,
): BookingWebAffiliateRepository {
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());

  return {
    async checkEmail(slug, email) {
      const identity = stableAffiliateIdentity(slug, email);
      const result = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM platform.domain_events event
           WHERE event.source_system = 'marketplace'
             AND event.event_key = $1
             AND event.event_type = 'marketplace.affiliate.public_registered'
             AND event.resource_product = 'marketplace'
             AND event.resource_type = 'affiliate'
             AND event.resource_id = $2
             AND event.payload ->> 'hotelSlug' = lower($3)
             AND event.payload ->> 'emailHash' = $4
         ) AS exists`,
        [registrationEventKey(identity.affiliateId), identity.affiliateId, slug, sha256(email)],
      );
      return { exists: result.rows[0]?.exists === true };
    },
    async register(slug, request) {
      const email = normalizeEmail(request.email);
      const fullName = typeof request.fullName === "string" ? request.fullName.trim() : "";
      if (!email) throw createHttpError(400, "Email is required.");
      if (!fullName) throw createHttpError(400, "Full name is required.");

      const identity = stableAffiliateIdentity(slug, email);
      const timestamp = now().toISOString();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await insertRegistrationEvent(client, {
          identity,
          slug,
          email,
          request,
          timestamp,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      return { id: identity.affiliateId, referralCode: identity.referralCode };
    },
    async createStripeConnectLink(slug, affiliateId, request) {
      const email = normalizeEmail(request.email);
      if (!email) throw createHttpError(400, "Email is required.");

      const timestamp = now().toISOString();
      const client = await pool.connect();
      try {
        const affiliate = await findAffiliateRegistration(client, {
          slug,
          affiliateId,
          email,
        });
        if (!affiliate) {
          throw createHttpError(404, "Affiliate not found for this hotel and email.");
        }
        if (!config.stripeConnectProvider) {
          throw createHttpError(503, "Stripe Connect onboarding is not configured.");
        }

        const providerAccount = await config.stripeConnectProvider.createAffiliateOnboardingLink({
          affiliateId,
          email,
          idempotencyKey: affiliateId,
          slug,
        });
        await client.query("BEGIN");
        await insertStripeConnectEvent(client, {
          affiliateId,
          providerAccountId: providerAccount.providerAccountId,
          timestamp,
        });
        await client.query("COMMIT");
        return { onboardingUrl: providerAccount.onboardingUrl };
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {}
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export function createPgBookingWebAffiliateHotelResolver(config: {
  connectionString: string;
  max?: number;
}): BookingWebAffiliateHotelResolver {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async findProfileBySlug(slug) {
      const result = await pool.query<{ slug: string }>(
        `SELECT profile.canonical_slug AS slug
         FROM hotel_catalog.property_public_profile_read_model profile
         JOIN hotel_catalog.property_slugs property_slug
           ON property_slug.property_id = profile.property_id
          AND property_slug.slug = lower($1)
          AND property_slug.purpose = 'canonical'
          AND property_slug.status = 'active'
         WHERE profile.canonical_slug = lower($1)
           AND profile.profile_status NOT IN ('disabled', 'private')
         LIMIT 1`,
        [slug],
      );
      return result.rows[0] ?? null;
    },
    async close() {
      await pool.end();
    },
  };
}

async function assertHotelExists(
  repository: BookingWebAffiliateHotelResolver,
  slug: string,
): Promise<void> {
  const profile = await repository.findProfileBySlug(slug);
  if (!profile) {
    throw createHttpError(404, "Booking Web hotel profile not found.");
  }
}

async function findAffiliateRegistration(
  client: pg.PoolClient,
  input: {
    slug: string;
    affiliateId: string;
    email: string;
  },
): Promise<{ affiliateId: string } | null> {
  const identity = stableAffiliateIdentity(input.slug, input.email);
  if (identity.affiliateId !== input.affiliateId) {
    return null;
  }

  const result = await client.query<{ affiliateId: string }>(
    `SELECT event.resource_id AS "affiliateId"
	     FROM platform.domain_events event
	     WHERE event.source_system = 'marketplace'
	       AND event.event_key = $1
	       AND event.event_type = 'marketplace.affiliate.public_registered'
	       AND event.resource_product = 'marketplace'
	       AND event.resource_type = 'affiliate'
	       AND event.resource_id = $2
	       AND event.payload ->> 'hotelSlug' = lower($3)
	       AND event.payload ->> 'emailHash' = $4
	     LIMIT 1`,
    [
      registrationEventKey(identity.affiliateId),
      input.affiliateId,
      input.slug,
      sha256(input.email),
    ],
  );
  return result.rows[0] ?? null;
}

async function insertRegistrationEvent(
  client: pg.PoolClient,
  input: {
    identity: StableAffiliateIdentity;
    slug: string;
    email: string;
    request: BookingWebAffiliateRegistrationRequest;
    timestamp: string;
  },
): Promise<void> {
  const eventKey = registrationEventKey(input.identity.affiliateId);
  const payload = {
    affiliateId: input.identity.affiliateId,
    referralCode: input.identity.referralCode,
    hotelSlug: input.slug,
    emailHash: sha256(input.email),
    userType: input.request.userType ?? null,
    paymentMethod: input.request.paymentMethod ?? null,
    hasSocialMedia: Boolean(input.request.socialMedia),
  };

  const projection = await client.query<{ id: string }>(
    `INSERT INTO marketplace.property_affiliates (
       property_id, affiliate_id, referral_code, display_name, contact_email,
       contact_email_hash, social_media, affiliate_type, lifecycle_status,
       application_source, applied_at, updated_at
     )
     SELECT property_slug.property_id, $1, $2, $3, $4, $5, $6,
       CASE WHEN $7 = 'creator' THEN 'creator' ELSE 'guest' END,
       'pending', 'public_registration', $8::timestamptz, $8::timestamptz
     FROM hotel_catalog.property_slugs property_slug
     WHERE property_slug.slug = lower($9)
       AND property_slug.purpose = 'canonical'
       AND property_slug.status = 'active'
     ON CONFLICT (property_id, affiliate_id) DO NOTHING
     RETURNING id::text AS id`,
    [
      input.identity.affiliateId,
      input.identity.referralCode,
      input.request.fullName,
      input.email,
      sha256(input.email),
      input.request.socialMedia ?? null,
      input.request.userType ?? null,
      input.timestamp,
      input.slug,
    ],
  );
  if (!projection.rows[0]) {
    const existing = await client.query(
      `SELECT affiliate.id
       FROM marketplace.property_affiliates affiliate
       JOIN hotel_catalog.property_slugs property_slug
         ON property_slug.property_id = affiliate.property_id
        AND property_slug.slug = lower($1)
        AND property_slug.purpose = 'canonical'
        AND property_slug.status = 'active'
       WHERE affiliate.affiliate_id = $2
       LIMIT 1`,
      [input.slug, input.identity.affiliateId],
    );
    if (!existing.rows[0]) throw createHttpError(404, "Booking Web hotel profile not found.");
  }

  await client.query(
    `INSERT INTO platform.domain_events
       (
         source_system,
         event_key,
         event_type,
         event_version,
	         occurred_at,
	         tenant_scope,
	         organization_id,
         resource_product,
         resource_type,
         resource_id,
         actor_type,
         correlation_id,
         payload,
         event_metadata,
         privacy_scope
	       )
	     VALUES
	       ('marketplace', $1, 'marketplace.affiliate.public_registered', 1, $2,
	        'external', NULL, 'marketplace', 'affiliate', $3, 'system', $4,
	        $5::jsonb, $6::jsonb, 'confidential')
	     ON CONFLICT (source_system, event_key) DO NOTHING`,
    [
      eventKey,
      input.timestamp,
      input.identity.affiliateId,
      eventKey,
      JSON.stringify(payload),
      JSON.stringify({ source: "booking-web-affiliate-target" }),
    ],
  );

  await client.query(
    `INSERT INTO platform.product_audit_events
       (
         audit_key,
         product,
         action,
         occurred_at,
         tenant_scope,
         organization_id,
         actor_type,
         target_resource_product,
         target_resource_type,
         target_resource_id,
         correlation_id,
         redacted_payload,
         audit_metadata,
         retention_class,
	         privacy_scope
	       )
	     VALUES
	       ($1, 'marketplace', 'marketplace.affiliate.public_registered', $2,
	        'external', NULL, 'system', 'marketplace', 'affiliate', $3, $1,
	        $4::jsonb, $5::jsonb, 'standard', 'confidential')
	     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      eventKey,
      input.timestamp,
      input.identity.affiliateId,
      JSON.stringify(payload),
      JSON.stringify({ source: "booking-web-affiliate-target" }),
    ],
  );
}

async function insertStripeConnectEvent(
  client: pg.PoolClient,
  input: {
    affiliateId: string;
    providerAccountId: string;
    timestamp: string;
  },
): Promise<void> {
  const eventKey = `finance.affiliate.stripe_connect_link_requested:${input.affiliateId}:v1`;
  const payload = {
    affiliateId: input.affiliateId,
    provider: "stripe",
    providerAccountId: input.providerAccountId,
  };

  await client.query(
    `INSERT INTO platform.domain_events
       (
         source_system,
         event_key,
         event_type,
         event_version,
         occurred_at,
         tenant_scope,
         organization_id,
         resource_product,
         resource_type,
         resource_id,
         actor_type,
         correlation_id,
         payload,
         event_metadata,
         privacy_scope
	       )
	     VALUES
	       ('finance', $1, 'finance.affiliate.stripe_connect_link_requested', 1, $2,
	        'external', NULL, 'finance', 'payment_provider_account', $3, 'system', $1,
	        $4::jsonb, $5::jsonb, 'confidential')
	     ON CONFLICT (source_system, event_key) DO NOTHING`,
    [
      eventKey,
      input.timestamp,
      input.providerAccountId,
      JSON.stringify(payload),
      JSON.stringify({ source: "booking-web-affiliate-target" }),
    ],
  );

  await client.query(
    `INSERT INTO platform.product_audit_events
       (
         audit_key,
         product,
         action,
         occurred_at,
         tenant_scope,
         organization_id,
         actor_type,
         target_resource_product,
         target_resource_type,
         target_resource_id,
         correlation_id,
         redacted_payload,
         audit_metadata,
         retention_class,
         privacy_scope
	       )
	     VALUES
	       ($1, 'finance', 'finance.affiliate.stripe_connect_link_requested', $2,
	        'external', NULL, 'system', 'finance', 'payment_provider_account', $3, $1,
	        $4::jsonb, $5::jsonb, 'financial', 'confidential')
	     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      eventKey,
      input.timestamp,
      input.providerAccountId,
      JSON.stringify(payload),
      JSON.stringify({ source: "booking-web-affiliate-target" }),
    ],
  );
}

type StableAffiliateIdentity = {
  affiliateId: string;
  referralCode: string;
};

function stableAffiliateIdentity(slug: string, email: string): StableAffiliateIdentity {
  const normalizedEmail = normalizeEmail(email);
  const normalizedSlug = normalizeSlug(slug);
  const key = `${normalizedSlug}:${normalizedEmail}`;
  const affiliateHash = sha256(`affiliate:${key}`);
  const emailHash = sha256(`affiliate-email:${normalizedEmail}`);

  return {
    affiliateId: `aff_${affiliateHash.slice(0, 20)}`,
    referralCode: `VA${affiliateHash.slice(0, 8).toUpperCase()}`,
  };
}

function registrationEventKey(affiliateId: string): string {
  return `marketplace.affiliate.public_registered:${affiliateId}:v1`;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
    ? value.trim().toLowerCase()
    : "";
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createHttpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

type HttpError = Error & {
  statusCode: number;
};
