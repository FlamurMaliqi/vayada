import { createHash, randomUUID } from "node:crypto";

import type { RequestAuditMetadata } from "@vayada/backend-auth";
import {
  HOTEL_CATALOG_AMENITIES,
  HOTEL_CATALOG_CONTENT_LOCALES,
  HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
  createHotelCatalogStep1MediaAssignments,
  hotelCatalogAmenityLabel,
  parsePropertyMediaCommandError,
  parseSaveHotelCatalogStep1Response,
  type HotelCatalogAmenityKey,
  type HotelCatalogContentLocale,
  type HotelCatalogStep1ReadModel,
  type PropertyMediaAssignment,
  type SaveHotelCatalogStep1Error,
  type SaveHotelCatalogStep1Request,
  type SaveHotelCatalogStep1Result,
} from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { ensureCanonicalPropertySlug } from "../platform/publicBookabilityPublication.js";
import { advancePublicProfileRevision } from "../platform/sharedHotelSetupStatusReadModel.js";

const OPERATION = "hotel_catalog.step1.save";
const PERMISSION = "hotel_catalog.setup.manage";
const PREPARED_INTENT_LEASE_MS = 30 * 60_000;

type QueryClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

type TransactionClient = QueryClient & { release(): void };

export type HotelCatalogStep1Pool = QueryClient & {
  connect(): Promise<TransactionClient>;
  end(): Promise<void>;
};

export type HotelCatalogStep1Scope = {
  organizationId: string;
  propertyId: string;
  actorUserId: string;
};

export type HotelCatalogStep1State = {
  readModel: HotelCatalogStep1ReadModel;
  presentationAssignments: readonly (PropertyMediaAssignment & {
    role: "cover" | "gallery";
  })[];
};

export type SaveHotelCatalogStep1Command = HotelCatalogStep1Scope & {
  idempotencyKey: string;
  audit: RequestAuditMetadata;
  request: SaveHotelCatalogStep1Request;
  claimToken: string;
  writeProfileRevision: number;
};

export type PrepareHotelCatalogStep1Command = Omit<
  SaveHotelCatalogStep1Command,
  "claimToken" | "writeProfileRevision"
>;

export type PrepareHotelCatalogStep1Result =
  | {
      kind: "prepared";
      claimToken: string;
      mediaRequired: boolean;
      state: HotelCatalogStep1State;
    }
  | { kind: "result"; result: SaveHotelCatalogStep1Result };

export type HotelCatalogStep1Repository = {
  getState(scope: HotelCatalogStep1Scope): Promise<HotelCatalogStep1State | null>;
  prepare(command: PrepareHotelCatalogStep1Command): Promise<PrepareHotelCatalogStep1Result>;
  save(command: SaveHotelCatalogStep1Command): Promise<SaveHotelCatalogStep1Result>;
  completeFailure(
    command: PrepareHotelCatalogStep1Command & {
      claimToken: string;
      error: SaveHotelCatalogStep1Error;
    },
  ): Promise<SaveHotelCatalogStep1Result>;
  close(): Promise<void>;
};

type PropertyRow = {
  propertyId: string;
  displayName: string;
  defaultLocale: string;
  supportedLocales: string[];
  profileRevision: string | number;
};

type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
  lockedUntil: Date | string | null;
};

export function createPgHotelCatalogStep1Repository(config: {
  connectionString: string;
  max?: number;
  pool?: HotelCatalogStep1Pool;
  now?: () => Date;
  randomId?: () => string;
}): HotelCatalogStep1Repository {
  if (!config.connectionString.trim()) {
    throw new Error("Hotel Catalog Step 1 repository connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool = (config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    })) as HotelCatalogStep1Pool;
  const now = config.now ?? (() => new Date());
  const randomId = config.randomId ?? randomUUID;

  return {
    async getState(scope) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const property = await lockAuthorizedProperty(client, scope);
        if (!property) {
          await rollback(client);
          return null;
        }
        const state = await loadState(client, property);
        await client.query("COMMIT");
        return state;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async prepare(command) {
      const occurredAt = now();
      const hashedKey = keyHash(command);
      const fingerprint = requestFingerprint(command);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const property = await lockAuthorizedProperty(client, command);
        if (!property) {
          await rollback(client);
          return { kind: "result", result: propertyNotFound() };
        }
        const existing = await loadIdempotency(client, command.propertyId, hashedKey);
        if (existing) {
          const terminal = terminalIdempotencyResult(existing, command.propertyId, fingerprint);
          if (terminal) {
            await client.query("COMMIT");
            return { kind: "result", result: terminal };
          }
          if (isLeaseActive(existing.lockedUntil, occurredAt)) {
            await client.query("COMMIT");
            return { kind: "result", result: commandInProgress() };
          }
          const metadata = preparedMetadata(existing.idempotencyMetadata);
          if (!metadata) throw new Error("Prepared Step 1 intent metadata is invalid");
          const claimToken = randomId();
          await claimPreparedIntent(client, existing.id, claimToken, occurredAt);
          const state = await loadState(client, property);
          const currentRevision = state.readModel.profileRevision;
          if (!metadata.mediaRequired && currentRevision !== metadata.baseProfileRevision) {
            const result: SaveHotelCatalogStep1Result = {
              ok: false,
              error: { code: "profile_revision_conflict", currentRevision },
            };
            await finalizeConflict(
              client,
              { ...command, claimToken, writeProfileRevision: currentRevision },
              existing.id,
              hashedKey,
              result,
              occurredAt,
            );
            return { kind: "result", result };
          }
          await client.query("COMMIT");
          return { kind: "prepared", claimToken, mediaRequired: metadata.mediaRequired, state };
        }

        const claimToken = randomId();
        const currentRevision = asRevision(property.profileRevision);
        if (currentRevision !== command.request.expectedProfileRevision) {
          const idempotencyId = await reserveIdempotency(
            client,
            command,
            hashedKey,
            fingerprint,
            claimToken,
            command.request.expectedProfileRevision,
            false,
            occurredAt,
          );
          if (!idempotencyId) throw new Error("Unable to reserve serialized Step 1 conflict");
          const result: SaveHotelCatalogStep1Result = {
            ok: false,
            error: { code: "profile_revision_conflict", currentRevision },
          };
          await finalizeConflict(
            client,
            { ...command, claimToken, writeProfileRevision: currentRevision },
            idempotencyId,
            hashedKey,
            result,
            occurredAt,
          );
          return { kind: "result", result };
        }
        const state = await loadState(client, property);
        const desiredAssignments = createHotelCatalogStep1MediaAssignments(
          command.request.media,
          state.readModel.displayName,
        );
        const mediaRequired = !samePresentationAssignments(
          state.presentationAssignments,
          desiredAssignments,
        );
        const idempotencyId = await reserveIdempotency(
          client,
          command,
          hashedKey,
          fingerprint,
          claimToken,
          currentRevision,
          mediaRequired,
          occurredAt,
        );
        if (!idempotencyId) throw new Error("Unable to reserve serialized Step 1 intent");
        await client.query("COMMIT");
        return { kind: "prepared", claimToken, mediaRequired, state };
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async save(command) {
      const occurredAt = now();
      const hashedKey = keyHash(command);
      const fingerprint = requestFingerprint(command);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const property = await lockAuthorizedProperty(client, command);
        if (!property) {
          await rollback(client);
          return { ok: false, error: { code: "property_not_found" } };
        }
        const existing = await loadIdempotency(client, command.propertyId, hashedKey);
        if (!existing) throw new Error("Step 1 save requires a prepared intent");
        const terminal = terminalIdempotencyResult(existing, command.propertyId, fingerprint);
        if (terminal) {
          await client.query("COMMIT");
          return terminal;
        }
        if (!hasClaimToken(existing, command.claimToken)) {
          await client.query("COMMIT");
          return commandInProgress();
        }
        const idempotencyId = existing.id;

        const currentRevision = asRevision(property.profileRevision);
        if (currentRevision !== command.writeProfileRevision) {
          return finalizeConflict(
            client,
            command,
            idempotencyId,
            hashedKey,
            { ok: false, error: { code: "profile_revision_conflict", currentRevision } },
            occurredAt,
          );
        }

        await writeProfile(client, command, occurredAt);
        await writeAmenities(client, command, occurredAt);
        const publicSlug = await ensureCanonicalPropertySlug(client, command.propertyId);
        if (!publicSlug) throw new Error("Authorized Hotel Catalog property disappeared");
        await advancePublicProfileRevision(client, command.propertyId);
        const updatedProperty = await selectProperty(client, command.propertyId);
        if (!updatedProperty) throw new Error("Updated Hotel Catalog property disappeared");
        const profileRevision = asRevision(updatedProperty.profileRevision);
        if (profileRevision !== currentRevision + 1) {
          throw new Error("Hotel Catalog profile revision did not advance exactly once");
        }
        await markAmenitiesReviewed(client, command, occurredAt);
        await markPresentHotelComplete(client, command, occurredAt);

        const state = await loadState(client, updatedProperty);
        const result: SaveHotelCatalogStep1Result = {
          ok: true,
          response: { ...state.readModel, outcome: "updated" },
        };
        const domainEventId = randomId();
        await insertDomainEvent(client, command, domainEventId, hashedKey, occurredAt, result);
        await insertOutbox(
          client,
          command,
          domainEventId,
          randomId(),
          hashedKey,
          occurredAt,
          result,
        );
        await recordAudit(
          client,
          command,
          idempotencyId,
          hashedKey,
          result,
          occurredAt,
          domainEventId,
        );
        await completeIdempotency(client, idempotencyId, result, occurredAt);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async completeFailure(command) {
      const occurredAt = now();
      const hashedKey = keyHash(command);
      const fingerprint = requestFingerprint(command);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (!(await lockAuthorizedProperty(client, command))) {
          await rollback(client);
          return propertyNotFound();
        }
        const existing = await loadIdempotency(client, command.propertyId, hashedKey);
        if (!existing) throw new Error("Step 1 failure requires a prepared intent");
        const terminal = terminalIdempotencyResult(existing, command.propertyId, fingerprint);
        if (terminal) {
          await client.query("COMMIT");
          return terminal;
        }
        if (!hasClaimToken(existing, command.claimToken)) {
          await client.query("COMMIT");
          return commandInProgress();
        }
        const result: SaveHotelCatalogStep1Result = { ok: false, error: command.error };
        if (command.error.code === "command_in_progress") {
          await releasePreparedIntent(client, existing.id, occurredAt);
          await client.query("COMMIT");
          return result;
        }
        await recordAudit(
          client,
          { ...command, writeProfileRevision: command.request.expectedProfileRevision },
          existing.id,
          hashedKey,
          result,
          occurredAt,
          null,
        );
        await completeIdempotency(client, existing.id, result, occurredAt);
        await client.query("COMMIT");
        return result;
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

async function lockAuthorizedProperty(
  client: QueryClient,
  scope: HotelCatalogStep1Scope,
): Promise<PropertyRow | null> {
  const result = await client.query<PropertyRow>(
    `SELECT property.id::text AS "propertyId",
            property.display_name AS "displayName",
            property.default_locale AS "defaultLocale",
            property.supported_locales AS "supportedLocales",
            property.profile_revision AS "profileRevision"
     FROM hotel_catalog.properties property
     JOIN identity.organizations organization
       ON organization.id = $1::uuid
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = organization.id
      AND resource.product = 'hotel_catalog'
      AND resource.resource_type = 'property'
      AND resource.resource_id = property.id::text
      AND resource.relationship IN ('owner', 'operator')
      AND resource.status = 'active'
     JOIN identity.users actor
       ON actor.id = $3::uuid
      AND actor.status = 'active'
     JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id
      AND membership.user_id = actor.id
      AND membership.status = 'active'
     JOIN identity.role_permission_grants permission_grant
       ON permission_grant.organization_kind = 'hotel_group'
      AND permission_grant.role_key = membership.role_key
      AND permission_grant.permission_key = $4
     WHERE property.id = $2::uuid
     FOR UPDATE OF property
     FOR SHARE OF organization, resource, actor, membership
     FOR KEY SHARE OF permission_grant`,
    [scope.organizationId, scope.propertyId, scope.actorUserId, PERMISSION],
  );
  return result.rows[0] ?? null;
}

async function selectProperty(
  client: QueryClient,
  propertyId: string,
): Promise<PropertyRow | null> {
  const result = await client.query<PropertyRow>(
    `SELECT id::text AS "propertyId",
            display_name AS "displayName",
            default_locale AS "defaultLocale",
            supported_locales AS "supportedLocales",
            profile_revision AS "profileRevision"
     FROM hotel_catalog.properties
     WHERE id = $1::uuid`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

async function loadState(
  client: QueryClient,
  property: PropertyRow,
): Promise<HotelCatalogStep1State> {
  const supportedLocales = normalizedLocales(property.supportedLocales, property.defaultLocale);
  const locale = supportedLocales.includes(property.defaultLocale as HotelCatalogContentLocale)
    ? (property.defaultLocale as HotelCatalogContentLocale)
    : supportedLocales[0]!;
  const profile = await client.query<{ shortDescription: string | null }>(
    `SELECT short_description AS "shortDescription"
       FROM hotel_catalog.property_profiles
       WHERE property_id = $1::uuid AND locale = $2`,
    [property.propertyId, locale],
  );
  const slug = await client.query<{ slug: string }>(
    `SELECT slug
       FROM hotel_catalog.property_slugs
       WHERE property_id = $1::uuid AND purpose = 'canonical' AND status = 'active'
       ORDER BY updated_at DESC, id
       LIMIT 1`,
    [property.propertyId],
  );
  const amenities = await client.query<{ amenityKey: string }>(
    `SELECT amenity_key AS "amenityKey"
       FROM hotel_catalog.property_amenities
       WHERE property_id = $1::uuid AND public_safe = TRUE
       ORDER BY amenity_key`,
    [property.propertyId],
  );
  const review = await client.query(
    `SELECT property_id
       FROM hotel_catalog.property_amenity_review_state
       WHERE property_id = $1::uuid`,
    [property.propertyId],
  );
  const media = await client.query<{
    mediaObjectId: string;
    mediaType: "hero_image" | "gallery_image";
    altText: string | null;
    sortOrder: number;
  }>(
    `SELECT platform_media_object_id::text AS "mediaObjectId",
              media_type AS "mediaType",
              alt_text AS "altText",
              sort_order AS "sortOrder"
       FROM hotel_catalog.property_media
       WHERE property_id = $1::uuid
         AND media_type IN ('hero_image', 'gallery_image')
         AND source_system = 'platform'
         AND public_approved = TRUE
         AND platform_media_object_id IS NOT NULL
       ORDER BY sort_order, id`,
    [property.propertyId],
  );
  const profileRevision = asRevision(property.profileRevision);
  const selectedAmenities = amenities.rows
    .map(({ amenityKey }) => amenityKey)
    .filter((key): key is HotelCatalogAmenityKey => Object.hasOwn(HOTEL_CATALOG_AMENITIES, key));
  const assignments = media.rows.map((row) => ({
    mediaObjectId: row.mediaObjectId,
    role: row.mediaType === "hero_image" ? ("cover" as const) : ("gallery" as const),
    altText: row.altText,
    sortOrder: row.sortOrder,
  }));
  const cover = assignments.find(({ role }) => role === "cover")?.mediaObjectId ?? null;
  const gallery = assignments
    .filter(({ role }) => role === "gallery")
    .map(({ mediaObjectId }) => mediaObjectId);
  const revisionToken = `profile:${profileRevision}`;
  return {
    readModel: {
      contractVersion: HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
      propertyId: property.propertyId,
      displayName: property.displayName,
      profileRevision,
      supportedLocales,
      profile: {
        locale,
        shortDescription: profile.rows[0]?.shortDescription ?? null,
        publicSlug: slug.rows[0]?.slug ?? null,
        amenities: { reviewed: (review.rowCount ?? 0) > 0, keys: selectedAmenities },
        media: { coverMediaObjectId: cover, galleryMediaObjectIds: gallery },
      },
      baseRevisions: {
        "hotel_catalog.profile": revisionToken,
        "hotel_catalog.media": revisionToken,
        "hotel_catalog.amenities": revisionToken,
      },
    },
    presentationAssignments: assignments,
  };
}

async function writeProfile(
  client: QueryClient,
  command: SaveHotelCatalogStep1Command,
  occurredAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE hotel_catalog.properties
     SET default_locale = $2,
         supported_locales = ARRAY(
           SELECT DISTINCT locale
           FROM unnest(supported_locales || ARRAY[$2]::text[]) locale
           WHERE locale = ANY($3::text[])
           ORDER BY locale
         ),
         updated_at = $4::timestamptz
     WHERE id = $1::uuid`,
    [
      command.propertyId,
      command.request.locale,
      HOTEL_CATALOG_CONTENT_LOCALES,
      occurredAt.toISOString(),
    ],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_profiles (
       property_id, locale, short_description, source_confidence, created_at, updated_at
     ) VALUES ($1::uuid, $2, $3, 'verified', $4::timestamptz, $4::timestamptz)
     ON CONFLICT (property_id, locale) DO UPDATE
     SET short_description = EXCLUDED.short_description,
         source_confidence = 'verified',
         updated_at = EXCLUDED.updated_at`,
    [
      command.propertyId,
      command.request.locale,
      command.request.shortDescription,
      occurredAt.toISOString(),
    ],
  );
}

async function writeAmenities(
  client: QueryClient,
  command: SaveHotelCatalogStep1Command,
  occurredAt: Date,
): Promise<void> {
  await client.query(`DELETE FROM hotel_catalog.property_amenities WHERE property_id = $1::uuid`, [
    command.propertyId,
  ]);
  if (command.request.amenities.keys.length === 0) return;
  await client.query(
    `INSERT INTO hotel_catalog.property_amenities (
       property_id, amenity_key, label, source_system, public_safe, created_at, updated_at
     )
     SELECT $1::uuid, input.key, input.label, 'platform', TRUE, $3::timestamptz, $3::timestamptz
     FROM jsonb_to_recordset($2::jsonb) AS input(key text, label text)`,
    [
      command.propertyId,
      JSON.stringify(
        command.request.amenities.keys.map((key) => ({
          key,
          label: hotelCatalogAmenityLabel(key),
        })),
      ),
      occurredAt.toISOString(),
    ],
  );
}

async function markAmenitiesReviewed(
  client: QueryClient,
  command: SaveHotelCatalogStep1Command,
  occurredAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO hotel_catalog.property_amenity_review_state (
       property_id, reviewed_by_user_id, reviewed_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3::timestamptz, $3::timestamptz)
     ON CONFLICT (property_id) DO UPDATE
     SET reviewed_by_user_id = EXCLUDED.reviewed_by_user_id,
         reviewed_at = EXCLUDED.reviewed_at,
         updated_at = EXCLUDED.updated_at`,
    [command.propertyId, command.actorUserId, occurredAt.toISOString()],
  );
}

async function markPresentHotelComplete(
  client: QueryClient,
  command: SaveHotelCatalogStep1Command,
  occurredAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE hotel_catalog.property_setup_sessions
     SET completed_step_ids = CASE
           WHEN 'present_hotel' = ANY(completed_step_ids) THEN completed_step_ids
           ELSE array_append(completed_step_ids, 'present_hotel')
         END,
         revision = revision + 1,
         retention_expires_at = $3::timestamptz + interval '90 days',
         updated_at = $3::timestamptz
     WHERE organization_id = $1::uuid
       AND property_id = $2::uuid
       AND status = 'active'
       AND retention_expires_at > $3::timestamptz`,
    [command.organizationId, command.propertyId, occurredAt.toISOString()],
  );
}

async function loadIdempotency(
  client: QueryClient,
  propertyId: string,
  hashedKey: string,
): Promise<IdempotencyRow | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status,
            request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            idempotency_metadata AS "idempotencyMetadata",
            locked_until AS "lockedUntil"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'hotel_catalog'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND organization_id IS NULL
       AND property_id = $3::uuid
     FOR UPDATE`,
    [OPERATION, hashedKey, propertyId],
  );
  return result.rows[0] ?? null;
}

function terminalIdempotencyResult(
  existing: IdempotencyRow,
  propertyId: string,
  fingerprint: string,
): SaveHotelCatalogStep1Result | null {
  if (existing.requestFingerprintHash !== fingerprint) {
    return { ok: false, error: { code: "idempotency_key_conflict" } };
  }
  if (existing.status === "in_progress") {
    return isPreparedMetadata(existing.idempotencyMetadata)
      ? null
      : { ok: false, error: { code: "idempotency_key_conflict" } };
  }
  if (existing.status !== "completed") {
    return { ok: false, error: { code: "idempotency_key_conflict" } };
  }
  const stored = parseStoredResult(existing.idempotencyMetadata, propertyId);
  if (
    !stored ||
    existing.responseStatusCode !== resultStatus(stored) ||
    existing.responseBodyHash !== sha256(JSON.stringify(resultBody(stored)))
  ) {
    return { ok: false, error: { code: "idempotency_key_conflict" } };
  }
  return stored.ok
    ? { ok: true, response: { ...stored.response, outcome: "idempotent_replay" } }
    : stored;
}

async function reserveIdempotency(
  client: QueryClient,
  command: PrepareHotelCatalogStep1Command,
  hashedKey: string,
  fingerprint: string,
  claimToken: string,
  baseProfileRevision: number,
  mediaRequired: boolean,
  occurredAt: Date,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, locked_until, expires_at, idempotency_metadata
     ) VALUES (
       'hotel_catalog', $1, $2, $3,
       'property', NULL, $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $7::timestamptz, 'infinity'::timestamptz,
       jsonb_build_object(
         'phase', 'prepared',
         'claimToken', $8::text,
         'baseProfileRevision', $9::integer,
         'mediaRequired', $10::boolean
       )
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      OPERATION,
      hashedKey,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      occurredAt.toISOString(),
      leaseUntil(occurredAt).toISOString(),
      claimToken,
      baseProfileRevision,
      mediaRequired,
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function claimPreparedIntent(
  client: QueryClient,
  idempotencyId: string,
  claimToken: string,
  occurredAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys
     SET idempotency_metadata = jsonb_build_object(
           'phase', 'prepared',
           'claimToken', $2::text,
           'baseProfileRevision', idempotency_metadata->'baseProfileRevision',
           'mediaRequired', idempotency_metadata->'mediaRequired'
         ),
         locked_until = $3::timestamptz,
         last_seen_at = $4::timestamptz
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [idempotencyId, claimToken, leaseUntil(occurredAt).toISOString(), occurredAt.toISOString()],
  );
}

async function releasePreparedIntent(
  client: QueryClient,
  idempotencyId: string,
  occurredAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys
     SET locked_until = $2::timestamptz, last_seen_at = $2::timestamptz
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [idempotencyId, occurredAt.toISOString()],
  );
}

async function finalizeConflict(
  client: QueryClient,
  command: SaveHotelCatalogStep1Command,
  idempotencyId: string,
  hashedKey: string,
  result: SaveHotelCatalogStep1Result,
  occurredAt: Date,
): Promise<SaveHotelCatalogStep1Result> {
  await recordAudit(client, command, idempotencyId, hashedKey, result, occurredAt, null);
  await completeIdempotency(client, idempotencyId, result, occurredAt);
  await client.query("COMMIT");
  return result;
}

async function insertDomainEvent(
  client: QueryClient,
  command: SaveHotelCatalogStep1Command,
  eventId: string,
  hashedKey: string,
  occurredAt: Date,
  result: SaveHotelCatalogStep1Result & { ok: true },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.domain_events (
       id, source_system, event_key, event_type, occurred_at,
       tenant_scope, organization_id, property_id,
       resource_product, resource_type, resource_id,
       actor_type, actor_user_id, correlation_id, idempotency_key_hash,
       payload, event_metadata
     ) VALUES (
       $1::uuid, 'hotel_catalog', $2, 'hotel_catalog.property.step1.saved', $3::timestamptz,
       'property', NULL, $4::uuid,
       'hotel_catalog', 'property', $4::uuid::text,
       'user', $5::uuid, $6, $7,
       $8::jsonb, jsonb_build_object('contractVersion', $9::text)
     )`,
    [
      eventId,
      `hotel_catalog.property.${command.propertyId}.step1.${result.response.profileRevision}.saved.v1`,
      occurredAt.toISOString(),
      command.propertyId,
      command.actorUserId,
      command.audit.correlationId ?? command.audit.requestId,
      hashedKey,
      JSON.stringify(eventPayload(command, result.response.profileRevision)),
      HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
    ],
  );
}

async function insertOutbox(
  client: QueryClient,
  command: SaveHotelCatalogStep1Command,
  domainEventId: string,
  outboxId: string,
  hashedKey: string,
  occurredAt: Date,
  result: SaveHotelCatalogStep1Result & { ok: true },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.outbox_events (
       id, domain_event_id, outbox_key, destination, event_type,
       tenant_scope, organization_id, property_id,
       resource_product, resource_type, resource_id,
       correlation_id, idempotency_key_hash, payload, outbox_metadata,
       available_at, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'hotel-catalog.projections',
       'hotel_catalog.property.step1.saved',
       'property', NULL, $4::uuid,
       'hotel_catalog', 'property', $4::uuid::text,
       $5, $6, $7::jsonb, jsonb_build_object('contractVersion', $8::text),
       $9::timestamptz, $9::timestamptz, $9::timestamptz
     )`,
    [
      outboxId,
      domainEventId,
      `hotel_catalog.property.${command.propertyId}.step1.${result.response.profileRevision}.project.v1`,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      hashedKey,
      JSON.stringify(eventPayload(command, result.response.profileRevision)),
      HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
      occurredAt.toISOString(),
    ],
  );
}

async function recordAudit(
  client: QueryClient,
  command: SaveHotelCatalogStep1Command,
  idempotencyId: string,
  hashedKey: string,
  result: SaveHotelCatalogStep1Result,
  occurredAt: Date,
  domainEventId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at,
       tenant_scope, organization_id, property_id,
       actor_type, actor_user_id,
       target_resource_product, target_resource_type, target_resource_id,
       domain_event_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, audit_metadata
     ) VALUES (
       $1, 'hotel_catalog', $2, $3::timestamptz,
       'property', NULL, $4::uuid,
       'user', $5::uuid,
       'hotel_catalog', 'property', $4::uuid::text,
       $6::uuid, $7::uuid, $8, $9,
       $10::jsonb, jsonb_build_object('source', 'api', 'contractVersion', $11::text)
     )`,
    [
      `hotel_catalog.property.${command.propertyId}.step1.key.${hashedKey}.v1`,
      result.ok ? "hotel_catalog.property.step1.saved" : "hotel_catalog.property.step1.rejected",
      occurredAt.toISOString(),
      command.propertyId,
      command.actorUserId,
      domainEventId,
      idempotencyId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify({
        outcome: result.ok ? result.response.outcome : result.error.code,
        locale: command.request.locale,
        expectedProfileRevision: command.request.expectedProfileRevision,
        amenityCount: command.request.amenities.keys.length,
        mediaCount:
          command.request.media.galleryMediaObjectIds.length +
          (command.request.media.coverMediaObjectId ? 1 : 0),
      }),
      HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
    ],
  );
}

async function completeIdempotency(
  client: QueryClient,
  idempotencyId: string,
  result: SaveHotelCatalogStep1Result,
  occurredAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2,
         response_body_hash = $3, idempotency_metadata = $4::jsonb,
         last_seen_at = $5::timestamptz, completed_at = $5::timestamptz,
         locked_until = NULL
     WHERE id = $1::uuid`,
    [
      idempotencyId,
      resultStatus(result),
      sha256(JSON.stringify(resultBody(result))),
      JSON.stringify({ result }),
      occurredAt.toISOString(),
    ],
  );
}

function eventPayload(command: SaveHotelCatalogStep1Command, profileRevision: number) {
  return {
    propertyId: command.propertyId,
    profileRevision,
    locale: command.request.locale,
    amenityKeys: command.request.amenities.keys,
    coverMediaObjectId: command.request.media.coverMediaObjectId,
    galleryMediaObjectIds: command.request.media.galleryMediaObjectIds,
  };
}

function keyHash(command: Pick<SaveHotelCatalogStep1Command, "idempotencyKey" | "propertyId">) {
  return sha256(JSON.stringify({ propertyId: command.propertyId, key: command.idempotencyKey }));
}

function requestFingerprint(
  command: Pick<SaveHotelCatalogStep1Command, "organizationId" | "propertyId" | "request">,
) {
  return sha256(
    JSON.stringify({
      organizationId: command.organizationId,
      propertyId: command.propertyId,
      request: command.request,
    }),
  );
}

function parseStoredResult(value: unknown, propertyId: string): SaveHotelCatalogStep1Result | null {
  if (!isExactRecord(value, ["result"]) || !isRecord(value["result"])) return null;
  const result = value["result"];
  if (result["ok"] === false && isExactRecord(result, ["ok", "error"])) {
    if (
      isExactRecord(result["error"], ["code"]) &&
      result["error"]["code"] === "property_not_found"
    ) {
      return { ok: false, error: { code: "property_not_found" } };
    }
    const error = parsePropertyMediaCommandError(result["error"]);
    if (
      !error ||
      error.code === "idempotency_key_conflict" ||
      error.code === "command_in_progress"
    ) {
      return null;
    }
    return { ok: false, error };
  }
  if (!isExactRecord(result, ["ok", "response"]) || result["ok"] !== true) {
    return null;
  }
  const response = parseSaveHotelCatalogStep1Response(result["response"]);
  if (!response || response.propertyId !== propertyId || response.outcome !== "updated") {
    return null;
  }
  return { ok: true, response };
}

function resultStatus(result: SaveHotelCatalogStep1Result): number {
  if (result.ok) return 200;
  if (result.error.code === "property_not_found" || result.error.code === "media_not_found") {
    return 404;
  }
  if (result.error.code === "media_not_authorized") return 403;
  if (result.error.code === "media_not_ready") return 422;
  if (result.error.code === "media_publication_failed") return 503;
  return 409;
}

function resultBody(result: SaveHotelCatalogStep1Result): object {
  return result.ok ? result.response : result.error;
}

type PreparedMetadata = {
  phase: "prepared";
  claimToken: string;
  baseProfileRevision: number;
  mediaRequired: boolean;
};

function preparedMetadata(value: unknown): PreparedMetadata | null {
  if (
    !isRecord(value) ||
    value["phase"] !== "prepared" ||
    typeof value["claimToken"] !== "string" ||
    value["claimToken"].length === 0 ||
    !Number.isSafeInteger(value["baseProfileRevision"]) ||
    (value["baseProfileRevision"] as number) < 1 ||
    typeof value["mediaRequired"] !== "boolean"
  ) {
    return null;
  }
  return value as PreparedMetadata;
}

function isPreparedMetadata(value: unknown): value is PreparedMetadata {
  return preparedMetadata(value) !== null;
}

function hasClaimToken(existing: IdempotencyRow, claimToken: string): boolean {
  const metadata = preparedMetadata(existing.idempotencyMetadata);
  return (
    existing.status === "in_progress" && metadata !== null && metadata.claimToken === claimToken
  );
}

function samePresentationAssignments(
  left: readonly (PropertyMediaAssignment & { role: "cover" | "gallery" })[],
  right: readonly (PropertyMediaAssignment & { role: "cover" | "gallery" })[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isLeaseActive(value: Date | string | null, occurredAt: Date): boolean {
  return value !== null && new Date(value).getTime() > occurredAt.getTime();
}

function leaseUntil(occurredAt: Date): Date {
  return new Date(occurredAt.getTime() + PREPARED_INTENT_LEASE_MS);
}

function propertyNotFound(): SaveHotelCatalogStep1Result {
  return { ok: false, error: { code: "property_not_found" } };
}

function commandInProgress(): SaveHotelCatalogStep1Result {
  return { ok: false, error: { code: "command_in_progress" } };
}

function normalizedLocales(
  values: readonly string[],
  defaultLocale: string,
): HotelCatalogContentLocale[] {
  const allowed = values.filter((value): value is HotelCatalogContentLocale =>
    HOTEL_CATALOG_CONTENT_LOCALES.includes(value as HotelCatalogContentLocale),
  );
  if (HOTEL_CATALOG_CONTENT_LOCALES.includes(defaultLocale as HotelCatalogContentLocale)) {
    allowed.push(defaultLocale as HotelCatalogContentLocale);
  }
  const normalized = [...new Set(allowed)].sort() as HotelCatalogContentLocale[];
  return normalized.length > 0 ? normalized : ["en"];
}

function asRevision(value: string | number): number {
  const revision = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Invalid Hotel Catalog profile revision");
  }
  return revision;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

async function rollback(client: QueryClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}
