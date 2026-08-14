import { randomUUID } from "node:crypto";

import type {
  BookingActiveContentPointer,
  BookingContentLifecyclePort,
  BookingContentRevision,
  BookingContentRevisionId,
  OnboardingLifecycleJsonObject,
  ReadyProductReadinessEvidence,
} from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type DistributionBookingPublicationTransaction = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

type ProjectionClient = DistributionBookingPublicationTransaction & {
  release(): void;
};

export type DistributionBookingPublicationPool = {
  connect(): Promise<ProjectionClient>;
  end(): Promise<void>;
};

export type DistributionBookingPublicationInput = {
  operationId: string;
  outboxEventId: string;
  outboxLeaseToken: string;
  propertyId: string;
  expectedActiveRevisionId: string | null;
  expectedPropertyLifecycleRevision: number;
  requestedByUserId: string;
  readiness: {
    contractVersion: "onboarding-product-readiness.v1";
    product: "booking";
    status: "ready";
    sourceManifest: ReadyProductReadinessEvidence<"booking">["sourceManifest"];
    sourceManifestHash: string;
    readinessHash: string;
  };
  projectedAt: Date;
};

export interface DistributionBookingPublicationProjectionPort {
  projectPublication(
    input: DistributionBookingPublicationInput,
  ): Promise<BookingActiveContentPointer>;
  getActive(propertyId: string): Promise<BookingActiveContentPointer | null>;
  /** Holds the publication advisory lock until the caller commits or rolls back. */
  lockAndGetActive(
    transaction: DistributionBookingPublicationTransaction,
    propertyId: string,
  ): Promise<BookingActiveContentPointer | null>;
  close?(): Promise<void>;
}

export class BookingPublicationActiveRevisionConflictError extends Error {
  readonly currentActiveRevisionId: string | null;

  constructor(currentActiveRevisionId: string | null) {
    super("The active Booking content revision changed before publication");
    this.name = "BookingPublicationActiveRevisionConflictError";
    this.currentActiveRevisionId = currentActiveRevisionId;
  }
}

export class BookingPublicationPublicContentUnavailableError extends Error {
  constructor() {
    super("A fresh public Booking projection is not available");
    this.name = "BookingPublicationPublicContentUnavailableError";
  }
}

export class BookingPublicationLeaseLostError extends Error {
  constructor() {
    super("The Booking publication outbox lease is no longer current");
    this.name = "BookingPublicationLeaseLostError";
  }
}

export class BookingPublicationPropertyUnavailableError extends Error {
  constructor() {
    super("The property is not active for public Booking publication");
    this.name = "BookingPublicationPropertyUnavailableError";
  }
}

type ActiveRow = {
  propertyId: string;
  revisionId: string;
  activatedByUserId: string;
  activatedAt: Date | string;
};

type RevisionRow = {
  revisionId: string;
  propertyId: string;
  revisionNumber: number;
  sourceManifest: unknown;
  sourceManifestHash: string;
  readinessHash: string;
  publicContent: unknown;
  builtByUserId: string;
  builtAt: Date | string;
};

type PublicContentRow = { publicContent: OnboardingLifecycleJsonObject };

/**
 * Distribution-owned implementation of the Booking lifecycle boundary.
 * Projector retries use the operation ID as the immutable revision ID, so a
 * crash after append or activation can resume without creating a second revision.
 */
export function createPgDistributionBookingPublicationProjection(config: {
  connectionString: string;
  max?: number;
  pool?: DistributionBookingPublicationPool;
  randomId?: () => string;
}): DistributionBookingPublicationProjectionPort &
  Pick<BookingContentLifecyclePort, "appendRevision" | "activate" | "getActive"> {
  if (!config.connectionString.trim()) {
    throw new Error("Distribution Booking publication connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as DistributionBookingPublicationPool);
  const randomId = config.randomId ?? randomUUID;

  return {
    async appendRevision(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await lockPublicationScope(client, input.propertyId);
        const revision = await insertRevision(client, {
          revisionId: randomId(),
          propertyId: input.propertyId,
          readiness: input.readiness,
          publicContent: input.publicContent,
          builtByUserId: input.builtByUserId,
          builtAt: input.builtAt,
        });
        await client.query("COMMIT");
        return revision;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async activate(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await lockPublicationScope(client, input.propertyId);
        await assertActiveProperty(client, input.propertyId);
        const current = await selectActive(client, input.propertyId, true);
        if ((current?.revisionId ?? null) !== input.expectedActiveRevisionId) {
          throw new BookingPublicationActiveRevisionConflictError(current?.revisionId ?? null);
        }
        const active = await persistActive(client, {
          propertyId: input.propertyId,
          revisionId: input.revisionId,
          activatedByUserId: input.activatedByUserId,
          activatedAt: new Date(),
        });
        await client.query("COMMIT");
        return active;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async getActive(propertyId) {
      const client = await pool.connect();
      try {
        return await selectActive(client, propertyId, false);
      } finally {
        client.release();
      }
    },

    async lockAndGetActive(transaction, propertyId) {
      await lockPublicationScope(transaction, propertyId);
      return selectActive(transaction, propertyId, true);
    },

    async projectPublication(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await lockPublicationScope(client, input.propertyId);
        await assertActiveProperty(
          client,
          input.propertyId,
          input.expectedPropertyLifecycleRevision,
        );
        await assertCurrentOutboxLease(client, input);
        const current = await selectActive(client, input.propertyId, true);
        const existing = await selectRevision(client, input.operationId);
        if (existing) {
          assertMatchingRetry(existing, input);
          if (current?.revisionId === existing.revisionId) {
            await client.query("COMMIT");
            return activeProjection(current);
          }
          if ((current?.revisionId ?? null) !== input.expectedActiveRevisionId) {
            throw new BookingPublicationActiveRevisionConflictError(current?.revisionId ?? null);
          }
          const active = await persistActive(client, {
            propertyId: input.propertyId,
            revisionId: existing.revisionId as BookingContentRevisionId,
            activatedByUserId: input.requestedByUserId,
            activatedAt: input.projectedAt,
          });
          await client.query("COMMIT");
          return active;
        }

        if ((current?.revisionId ?? null) !== input.expectedActiveRevisionId) {
          throw new BookingPublicationActiveRevisionConflictError(current?.revisionId ?? null);
        }
        const publicContent = await loadPublicContent(client, input.propertyId);
        if (!publicContent) throw new BookingPublicationPublicContentUnavailableError();
        const revision = await insertRevision(client, {
          revisionId: input.operationId,
          propertyId: input.propertyId,
          readiness: input.readiness as ReadyProductReadinessEvidence<"booking">,
          publicContent,
          builtByUserId: input.requestedByUserId,
          builtAt: input.projectedAt.toISOString(),
        });
        const active = await persistActive(client, {
          propertyId: input.propertyId,
          revisionId: revision.revisionId,
          activatedByUserId: input.requestedByUserId,
          activatedAt: input.projectedAt,
        });
        await client.query("COMMIT");
        return active;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function assertCurrentOutboxLease(
  client: DistributionBookingPublicationTransaction,
  input: Pick<
    DistributionBookingPublicationInput,
    "outboxEventId" | "outboxLeaseToken" | "operationId" | "propertyId"
  >,
): Promise<void> {
  const result = await client.query(
    `SELECT id
     FROM platform.outbox_events
     WHERE id = $1::uuid
       AND property_id = $2::uuid
       AND resource_id = $3
       AND destination = 'distribution.booking-publication-projector'
       AND event_type = 'booking.publication.requested'
       AND status = 'leased'
       AND outbox_metadata #>> '{bookingPublicationProjection,leaseToken}' = $4
     FOR UPDATE`,
    [input.outboxEventId, input.propertyId, input.operationId, input.outboxLeaseToken],
  );
  if (result.rowCount !== 1) throw new BookingPublicationLeaseLostError();
}

async function lockPublicationScope(
  client: DistributionBookingPublicationTransaction,
  propertyId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtext('booking.publication'),
       hashtext($1::uuid::text)
     )`,
    [propertyId],
  );
}

async function assertActiveProperty(
  client: DistributionBookingPublicationTransaction,
  propertyId: string,
  expectedLifecycleRevision?: number,
): Promise<void> {
  const result = await client.query(
    `SELECT id
     FROM hotel_catalog.properties
     WHERE id = $1::uuid AND lifecycle_status = 'active'
       AND ($2::bigint IS NULL OR lifecycle_revision = $2::bigint)
     FOR SHARE`,
    [propertyId, expectedLifecycleRevision ?? null],
  );
  if (result.rowCount !== 1) throw new BookingPublicationPropertyUnavailableError();
}

async function selectActive(
  client: DistributionBookingPublicationTransaction,
  propertyId: string,
  forUpdate: boolean,
): Promise<BookingActiveContentPointer | null> {
  const result = await client.query<ActiveRow>(
    `SELECT property_id::text AS "propertyId",
            content_revision_id::text AS "revisionId",
            activated_by_user_id::text AS "activatedByUserId",
            activated_at AS "activatedAt"
     FROM distribution.active_public_booking_revision
     WHERE property_id = $1::uuid
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [propertyId],
  );
  return result.rows[0] ? activeProjection(result.rows[0]) : null;
}

async function selectRevision(
  client: ProjectionClient,
  revisionId: string,
): Promise<RevisionRow | null> {
  const result = await client.query<RevisionRow>(
    `SELECT id::text AS "revisionId",
            property_id::text AS "propertyId",
            revision_number AS "revisionNumber",
            source_manifest AS "sourceManifest",
            source_manifest_hash AS "sourceManifestHash",
            readiness_hash AS "readinessHash",
            public_content AS "publicContent",
            built_by_user_id::text AS "builtByUserId",
            built_at AS "builtAt"
     FROM distribution.public_booking_content_revisions
     WHERE id = $1::uuid`,
    [revisionId],
  );
  return result.rows[0] ?? null;
}

async function loadPublicContent(
  client: ProjectionClient,
  propertyId: string,
): Promise<OnboardingLifecycleJsonObject | null> {
  const result = await client.query<PublicContentRow>(
    `SELECT jsonb_build_object(
       'contractVersion', 'booking-public-content.v1',
       'profile', jsonb_build_object(
         'publicId', profile.public_id,
         'canonicalSlug', profile.canonical_slug,
         'canonicalUrl', profile.canonical_url,
         'bookingBaseUrl', profile.booking_base_url,
         'customDomainUrl', profile.custom_domain_url,
         'timezone', profile.timezone,
         'defaultLocale', profile.default_locale,
         'supportedLocales', to_jsonb(profile.supported_locales),
         'defaultCurrency', profile.default_currency,
         'supportedCurrencies', to_jsonb(profile.supported_currencies),
         'publicIdentity', profile.public_identity,
         'location', profile.location,
         'media', profile.media,
         'amenities', profile.amenities,
         'policies', profile.policies,
         'capabilities', profile.capabilities,
         'supportedQuoteParameters', profile.supported_quote_parameters
       ),
       'roomOffers', COALESCE((
         SELECT jsonb_agg(
           jsonb_build_object(
             'publicOfferKey', offer.public_offer_key,
             'stayDate', offer.stay_date,
             'availabilityStatus', offer.availability_status,
             'sellablePublicly', offer.sellable_publicly,
             'availableRooms', offer.available_rooms,
             'basePriceAmount', offer.base_price_amount,
             'taxesAndFeesAmount', offer.taxes_and_fees_amount,
             'discountsAmount', offer.discounts_amount,
             'currency', offer.currency,
             'occupancy', offer.occupancy,
             'roomSummary', offer.room_summary,
             'rateSummary', offer.rate_summary,
             'paymentOptions', to_jsonb(offer.payment_options),
             'publicPolicy', offer.public_policy,
             'unavailableReasons', to_jsonb(offer.unavailable_reasons)
           ) ORDER BY offer.stay_date, offer.public_offer_key
         )
         FROM distribution.public_room_offer_snapshots offer
         WHERE offer.property_id = profile.property_id
       ), '[]'::jsonb)
     ) AS "publicContent"
     FROM distribution.public_hotel_bookability_profiles profile
     WHERE profile.property_id = $1::uuid
       AND profile.profile_status = 'public'
       AND profile.freshness_status = 'fresh'`,
    [propertyId],
  );
  return result.rows[0]?.publicContent ?? null;
}

async function insertRevision(
  client: ProjectionClient,
  input: {
    revisionId: string;
    propertyId: string;
    readiness: ReadyProductReadinessEvidence<"booking">;
    publicContent: OnboardingLifecycleJsonObject;
    builtByUserId: string;
    builtAt: string;
  },
): Promise<BookingContentRevision> {
  const result = await client.query<RevisionRow>(
    `INSERT INTO distribution.public_booking_content_revisions (
       id, property_id, revision_number, readiness_contract_version,
       source_manifest, source_manifest_hash, readiness_hash,
       readiness_product, readiness_status, public_content,
       built_by_user_id, built_at
     )
     SELECT $1::uuid, $2::uuid,
            COALESCE(MAX(revision_number), 0) + 1,
            $3, $4::jsonb, $5, $6,
            'booking', 'ready', $7::jsonb, $8::uuid, $9::timestamptz
     FROM distribution.public_booking_content_revisions
     WHERE property_id = $2::uuid
     RETURNING id::text AS "revisionId",
               property_id::text AS "propertyId",
               revision_number AS "revisionNumber",
               source_manifest AS "sourceManifest",
               source_manifest_hash AS "sourceManifestHash",
               readiness_hash AS "readinessHash",
               public_content AS "publicContent",
               built_by_user_id::text AS "builtByUserId",
               built_at AS "builtAt"`,
    [
      input.revisionId,
      input.propertyId,
      input.readiness.contractVersion,
      JSON.stringify(input.readiness.sourceManifest),
      input.readiness.sourceManifestHash,
      input.readiness.readinessHash,
      JSON.stringify(input.publicContent),
      input.builtByUserId,
      input.builtAt,
    ],
  );
  return revisionProjection(result.rows[0]!);
}

async function persistActive(
  client: ProjectionClient,
  input: {
    propertyId: string;
    revisionId: BookingContentRevisionId;
    activatedByUserId: string;
    activatedAt: Date;
  },
): Promise<BookingActiveContentPointer> {
  const result = await client.query<ActiveRow>(
    `INSERT INTO distribution.active_public_booking_revision (
       property_id, content_revision_id, activated_by_user_id, activated_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)
     ON CONFLICT (property_id) DO UPDATE
     SET content_revision_id = EXCLUDED.content_revision_id,
         activated_by_user_id = EXCLUDED.activated_by_user_id,
         activated_at = EXCLUDED.activated_at
     RETURNING property_id::text AS "propertyId",
               content_revision_id::text AS "revisionId",
               activated_by_user_id::text AS "activatedByUserId",
               activated_at AS "activatedAt"`,
    [input.propertyId, input.revisionId, input.activatedByUserId, input.activatedAt.toISOString()],
  );
  return activeProjection(result.rows[0]!);
}

function assertMatchingRetry(
  existing: RevisionRow,
  input: DistributionBookingPublicationInput,
): void {
  if (
    existing.propertyId !== input.propertyId ||
    existing.sourceManifestHash !== input.readiness.sourceManifestHash ||
    existing.readinessHash !== input.readiness.readinessHash ||
    existing.builtByUserId !== input.requestedByUserId
  ) {
    throw new Error("Stored Booking publication revision does not match its operation");
  }
}

function revisionProjection(row: RevisionRow): BookingContentRevision {
  return Object.freeze({
    revisionId: row.revisionId as BookingContentRevisionId,
    propertyId: row.propertyId,
    revisionNumber: row.revisionNumber,
    readiness: Object.freeze({
      contractVersion: "onboarding-product-readiness.v1",
      propertyId: row.propertyId,
      product: "booking" as const,
      status: "ready" as const,
      sourceManifest: structuredClone(
        row.sourceManifest,
      ) as ReadyProductReadinessEvidence<"booking">["sourceManifest"],
      sourceManifestHash: row.sourceManifestHash as `sha256:${string}`,
      readinessHash: row.readinessHash as `sha256:${string}`,
    }) as ReadyProductReadinessEvidence<"booking">,
    publicContent: structuredClone(row.publicContent) as OnboardingLifecycleJsonObject,
    builtByUserId: row.builtByUserId,
    builtAt: toIso(row.builtAt),
  });
}

function activeProjection(
  row: ActiveRow | BookingActiveContentPointer,
): BookingActiveContentPointer {
  return Object.freeze({
    propertyId: row.propertyId,
    revisionId: row.revisionId as BookingContentRevisionId,
    activatedByUserId: row.activatedByUserId,
    activatedAt: toIso(row.activatedAt),
  });
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function rollback(client: ProjectionClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
