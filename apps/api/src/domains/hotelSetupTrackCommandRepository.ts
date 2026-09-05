import { createHash } from "node:crypto";

import type { RequestAuditMetadata } from "@vayada/backend-auth";
import {
  SETUP_TRACKS,
  SETUP_TRACK_COMPONENT_PRODUCTS,
  isSetupTrack,
  type SetupCommandError,
  type SetupComponentProduct,
  type SetupTrack,
  type TrackStatus,
  type UpdateTracksRequest,
  type UpdateTracksResponse,
} from "@vayada/domain-hotels";
import pg, { type PoolClient } from "pg";

import {
  requireAuthorizedPlatformActor,
  PlatformPropertyLifecycleError,
} from "./platformPropertyLifecycleCommandRepository.js";

import { hotelSetupTrackRequestFingerprint } from "./hotelSetupTrackCommandFingerprint.js";

export type HotelSetupTrackCommand = UpdateTracksRequest & {
  organizationId: string;
  idempotencyKey: string;
  actorUserId: string;
  audit: RequestAuditMetadata;
  adminActivation?: { platformOrganizationId: string; accountUserId: string; actorUserId: string };
};

export type HotelSetupTrackCommandResult =
  | { ok: true; response: UpdateTracksResponse }
  | { ok: false; error: SetupCommandError };

type IntentRow = {
  selectedTracks: SetupTrack[];
  revision: number;
};

type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
};

type EntitlementRow = {
  product: SetupComponentProduct;
  status: "active" | "suspended" | "expired";
  resourceProduct: string | null;
  resourceType: string | null;
  resourceId: string | null;
  startsAt: Date | string | null;
  expiresAt: Date | string | null;
  source: string | null;
};

type BillingRow = {
  product: SetupComponentProduct;
  billingStatus: string;
  startsAt: Date | string | null;
  expiresAt: Date | string | null;
};

type CatalogLink = {
  propertyId: string;
  relationship: "owner" | "operator";
};

type ProductLink = CatalogLink & {
  product: SetupComponentProduct;
  status: "active" | "suspended" | "archived";
};

type ComponentAccess = TrackStatus["components"][number]["access"];
type ProvisioningState = {
  access: Record<SetupComponentProduct, ComponentAccess>;
  links: ProductLink[];
  marketplaceProfileConflict: boolean;
};

const OPERATION = "hotel_setup.tracks.update";
const SETUP_SOURCE = "adaptive_hotel_setup";
const COMPONENT_PRODUCTS = ["pms", "booking", "marketplace"] as const;

export function createPgHotelSetupTrackCommandRepository(config: {
  connectionString: string;
  max?: number;
  now?: () => Date;
}) {
  if (!config.connectionString.trim()) {
    throw new Error("Hotel setup track command repository connectionString must not be empty");
  }

  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });
  const now = config.now ?? (() => new Date());

  return {
    async updateTracks(command: HotelSetupTrackCommand): Promise<HotelSetupTrackCommandResult> {
      const client = await pool.connect();
      const occurredAt = now();
      const keyHash = sha256(command.idempotencyKey);
      const fingerprint = hotelSetupTrackRequestFingerprint(command);

      try {
        await client.query("BEGIN");
        if (command.adminActivation) {
          await lockOrganization(client, command.organizationId);
          await requireAuthorizedPlatformActor(client, {
            actorUserId: command.actorUserId,
            organizationId: command.adminActivation.platformOrganizationId,
            requestId: command.audit.requestId,
            correlationId: command.audit.correlationId ?? command.audit.requestId,
            requestedAt: command.audit.receivedAt,
          });
          const account = await client.query(
            `SELECT membership.id FROM identity.organization_memberships membership
             JOIN identity.users account ON account.id = membership.user_id AND account.status = 'active'
             JOIN identity.organizations organization ON organization.id = membership.organization_id
               AND organization.kind = 'hotel_group' AND organization.status = 'active'
             WHERE membership.user_id = $1::uuid AND membership.organization_id = $2::uuid
               AND membership.status = 'active'
             FOR SHARE OF membership, account, organization`,
            [command.adminActivation.accountUserId, command.organizationId],
          );
          if (
            account.rows.length !== 1 ||
            command.adminActivation.actorUserId !== command.actorUserId
          ) {
            throw new PlatformPropertyLifecycleError("invalid_platform_scope");
          }
        }

        const replay = await findReplay(client, command, keyHash, fingerprint);
        if (replay) {
          await client.query("ROLLBACK");
          return replay;
        }

        const idempotencyId = await reserveIdempotency(
          client,
          command,
          keyHash,
          fingerprint,
          occurredAt,
        );
        if (!idempotencyId) {
          const concurrentReplay = await findReplay(client, command, keyHash, fingerprint);
          await client.query("ROLLBACK");
          return concurrentReplay ?? conflict("command_in_progress");
        }

        await lockOrganization(client, command.organizationId);
        const previous = await loadIntent(client, command.organizationId);
        const result = await executeCommand(client, command, previous, occurredAt);

        await recordAudit(client, {
          command,
          idempotencyId,
          keyHash,
          previous,
          result,
          occurredAt,
        });
        await completeIdempotency(client, idempotencyId, result, occurredAt);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async getTrackStatus(input: { organizationId: string }): Promise<UpdateTracksResponse> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const intent = await loadIntent(client, input.organizationId, false);
        const catalogLinks = await loadCatalogLinks(client, input.organizationId, false);
        const state = await loadProvisioningState(
          client,
          input.organizationId,
          catalogLinks,
          now(),
          false,
        );
        await client.query("COMMIT");
        return trackStatusResponse(intent, state, catalogLinks);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

export type HotelSetupTrackCommandRepository = ReturnType<
  typeof createPgHotelSetupTrackCommandRepository
>;

async function executeCommand(
  client: PoolClient,
  command: HotelSetupTrackCommand,
  previous: IntentRow | null,
  now: Date,
): Promise<HotelSetupTrackCommandResult> {
  const currentRevision = previous?.revision ?? 0;
  if (command.expectedRevision !== currentRevision) {
    return conflict("track_revision_conflict", currentRevision);
  }
  if (previous?.selectedTracks.some((track) => !command.selectedTracks.includes(track))) {
    return conflict("track_removal_requires_service_management", currentRevision);
  }

  if (
    command.adminActivation &&
    (!command.selectedTracks.includes("creator_marketplace") ||
      command.selectedTracks.includes("hotel_operations") !==
        (previous?.selectedTracks.includes("hotel_operations") ?? false))
  )
    throw new PlatformPropertyLifecycleError("invalid_platform_scope");

  const trackRevision = await persistIntent(client, command, previous);
  const catalogLinks = await loadCatalogLinks(client, command.organizationId);
  let state = await loadProvisioningState(client, command.organizationId, catalogLinks, now);

  for (const track of command.selectedTracks) {
    if (command.adminActivation && track !== "creator_marketplace") continue;
    if (trackIsBlocked(track, state, catalogLinks)) continue;
    const missingEntitlements = SETUP_TRACK_COMPONENT_PRODUCTS[track].filter(
      (product) => state.access[product] === "absent",
    );
    await provisionTrack(client, command.organizationId, track, missingEntitlements, now);
    state = await loadProvisioningState(client, command.organizationId, catalogLinks, now);
    if (!trackIsActive(track, state, catalogLinks)) {
      throw new Error(`Hotel setup track ${track} did not provision atomically`);
    }
  }

  const activeTracks = command.selectedTracks.filter((track) =>
    trackIsActive(track, state, catalogLinks),
  );
  await initializeProductRecords(
    client,
    command.organizationId,
    command.adminActivation
      ? activeTracks.filter((track) => track === "creator_marketplace")
      : activeTracks,
  );
  const response = trackStatusResponse(
    { selectedTracks: command.selectedTracks, revision: trackRevision },
    state,
    catalogLinks,
  );
  return { ok: true, response };
}

async function lockOrganization(client: PoolClient, organizationId: string): Promise<void> {
  const result = await client.query(
    `SELECT id
     FROM identity.organizations
     WHERE id = $1::uuid
       AND kind = 'hotel_group'
       AND status = 'active'
     FOR UPDATE`,
    [organizationId],
  );
  if (result.rowCount !== 1) throw new Error("Active hotel-group organization was not found");
}

async function loadIntent(
  client: PoolClient,
  organizationId: string,
  forUpdate = true,
): Promise<IntentRow | null> {
  const result = await client.query<IntentRow>(
    `SELECT selected_tracks AS "selectedTracks", revision
     FROM hotel_catalog.organization_setup_track_intents
     WHERE organization_id = $1::uuid
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [organizationId],
  );
  return result.rows[0] ?? null;
}

async function persistIntent(
  client: PoolClient,
  command: HotelSetupTrackCommand,
  previous: IntentRow | null,
): Promise<number> {
  if (!previous) {
    await client.query(
      `INSERT INTO hotel_catalog.organization_setup_track_intents
         (organization_id, selected_tracks, revision)
       VALUES ($1::uuid, $2::text[], 1)`,
      [command.organizationId, command.selectedTracks],
    );
    return 1;
  }
  if (sameTracks(previous.selectedTracks, command.selectedTracks)) return previous.revision;

  const revision = previous.revision + 1;
  const result = await client.query(
    `UPDATE hotel_catalog.organization_setup_track_intents
     SET selected_tracks = $2::text[],
         revision = $3,
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND revision = $4`,
    [command.organizationId, command.selectedTracks, revision, previous.revision],
  );
  if (result.rowCount !== 1) throw new Error("Hotel setup track revision changed unexpectedly");
  return revision;
}

async function loadCatalogLinks(
  client: PoolClient,
  organizationId: string,
  forUpdate = true,
): Promise<CatalogLink[]> {
  const result = await client.query<CatalogLink>(
    `SELECT link.resource_id AS "propertyId", link.relationship
     FROM identity.organization_resource_links link
     JOIN hotel_catalog.properties property ON property.id::text = link.resource_id
     WHERE link.organization_id = $1::uuid
       AND link.product = 'hotel_catalog'
       AND link.resource_type = 'property'
       AND link.relationship IN ('owner', 'operator')
       AND link.status = 'active'
     ORDER BY link.resource_id, link.relationship
     ${forUpdate ? "FOR UPDATE OF link, property" : ""}`,
    [organizationId],
  );
  return result.rows;
}

async function loadProvisioningState(
  client: PoolClient,
  organizationId: string,
  catalogLinks: CatalogLink[],
  now: Date,
  forUpdate = true,
): Promise<ProvisioningState> {
  const entitlements = await client.query<EntitlementRow>(
    `SELECT
       product,
       status,
       resource_product AS "resourceProduct",
       resource_type AS "resourceType",
       resource_id AS "resourceId",
       starts_at AS "startsAt",
       expires_at AS "expiresAt",
       metadata ->> 'source' AS source
     FROM identity.product_entitlements
     WHERE organization_id = $1::uuid
       AND product = ANY($2::text[])
       AND entitlement_key = CASE product
         WHEN 'pms' THEN 'property-management'
         WHEN 'booking' THEN 'booking-engine'
         WHEN 'marketplace' THEN 'marketplace-hotel-profile'
       END
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [organizationId, COMPONENT_PRODUCTS],
  );
  const billing = await client.query<BillingRow>(
    `SELECT
       product,
       billing_status AS "billingStatus",
       starts_at AS "startsAt",
       expires_at AS "expiresAt"
     FROM finance.billing_entitlements
     WHERE organization_id = $1::uuid
       AND product = ANY($2::text[])
       AND entitlement_key = CASE product
         WHEN 'pms' THEN 'property-management'
         WHEN 'booking' THEN 'booking-engine'
         WHEN 'marketplace' THEN 'marketplace-hotel-profile'
       END
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [organizationId, COMPONENT_PRODUCTS],
  );
  const links = await client.query<ProductLink>(
    `SELECT
       product,
       resource_id AS "propertyId",
       relationship,
       status
     FROM identity.organization_resource_links
     WHERE organization_id = $1::uuid
       AND product = ANY($2::text[])
       AND (
         (product = 'pms' AND resource_type = 'pms_property')
         OR (product = 'booking' AND resource_type = 'booking_hotel')
         OR (product = 'marketplace' AND resource_type = 'hotel_profile')
       )
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [organizationId, COMPONENT_PRODUCTS],
  );
  const marketplaceProfileConflicts = await client.query(
    `SELECT profile.property_id
     FROM marketplace.marketplace_hotel_profiles profile
     WHERE profile.property_id = ANY($2::uuid[])
       AND profile.organization_id <> $1::uuid
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [organizationId, catalogLinks.map((link) => link.propertyId)],
  );

  const access = Object.fromEntries(
    COMPONENT_PRODUCTS.map((product) => [
      product,
      componentAccess(product, entitlements.rows, billing.rows, now),
    ]),
  ) as Record<SetupComponentProduct, ComponentAccess>;
  return {
    access,
    links: links.rows.filter((link) =>
      catalogLinks.some(
        (catalog) =>
          catalog.propertyId === link.propertyId && catalog.relationship === link.relationship,
      ),
    ),
    marketplaceProfileConflict: (marketplaceProfileConflicts.rowCount ?? 0) > 0,
  };
}

function componentAccess(
  product: SetupComponentProduct,
  entitlements: EntitlementRow[],
  billing: BillingRow[],
  now: Date,
): ComponentAccess {
  const productEntitlements = entitlements.filter((row) => row.product === product);
  const accountEntitlements = productEntitlements.filter(isAccountScoped);
  const productBilling = billing.filter((row) => row.product === product);
  const startedBilling = productBilling.filter(
    (row) => !row.startsAt || new Date(row.startsAt) <= now,
  );
  const currentBilling = startedBilling.filter(
    (row) => !row.expiresAt || new Date(row.expiresAt) > now,
  );
  if (currentBilling.some((row) => ["past_due", "suspended"].includes(row.billingStatus))) {
    return "suspended";
  }

  const active = accountEntitlements.some(
    (row) =>
      row.status === "active" &&
      (!row.startsAt || new Date(row.startsAt) <= now) &&
      (!row.expiresAt || new Date(row.expiresAt) > now),
  );
  const suspended = accountEntitlements.some(
    (row) =>
      row.status === "suspended" &&
      (!row.startsAt || new Date(row.startsAt) <= now) &&
      (!row.expiresAt || new Date(row.expiresAt) > now),
  );
  if (suspended) return "suspended";
  const billingAllowsAccess = currentBilling.some((row) =>
    ["trialing", "active"].includes(row.billingStatus),
  );
  if (active && (startedBilling.length === 0 || billingAllowsAccess)) return "active";

  const externalCanonicalRow = accountEntitlements.some((row) => row.source !== SETUP_SOURCE);
  return externalCanonicalRow || startedBilling.length > 0 ? "unavailable" : "absent";
}

function isAccountScoped(row: EntitlementRow): boolean {
  return !row.resourceProduct && !row.resourceType && !row.resourceId;
}

function trackIsBlocked(
  track: SetupTrack,
  state: ProvisioningState,
  catalogLinks: CatalogLink[],
): boolean {
  return (
    (track === "creator_marketplace" && state.marketplaceProfileConflict) ||
    SETUP_TRACK_COMPONENT_PRODUCTS[track].some(
      (product) =>
        state.access[product] === "suspended" ||
        state.access[product] === "unavailable" ||
        hasBlockedLink(product, state.links, catalogLinks),
    )
  );
}

function trackIsActive(
  track: SetupTrack,
  state: ProvisioningState,
  catalogLinks: CatalogLink[],
): boolean {
  return SETUP_TRACK_COMPONENT_PRODUCTS[track].every(
    (product) =>
      state.access[product] === "active" && hasAllActiveLinks(product, state.links, catalogLinks),
  );
}

function hasBlockedLink(
  product: SetupComponentProduct,
  links: ProductLink[],
  catalogLinks: CatalogLink[],
): boolean {
  return catalogLinks.some((catalog) =>
    links.some(
      (link) =>
        link.product === product &&
        link.propertyId === catalog.propertyId &&
        link.relationship === catalog.relationship &&
        link.status !== "active",
    ),
  );
}

function hasAllActiveLinks(
  product: SetupComponentProduct,
  links: ProductLink[],
  catalogLinks: CatalogLink[],
): boolean {
  return catalogLinks.every((catalog) =>
    links.some(
      (link) =>
        link.product === product &&
        link.propertyId === catalog.propertyId &&
        link.relationship === catalog.relationship &&
        link.status === "active",
    ),
  );
}

async function provisionTrack(
  client: PoolClient,
  organizationId: string,
  track: SetupTrack,
  missingEntitlements: readonly SetupComponentProduct[],
  now: Date,
): Promise<void> {
  const products = SETUP_TRACK_COMPONENT_PRODUCTS[track];
  await client.query(
    `INSERT INTO identity.product_entitlements (
       organization_id, product, entitlement_key, status, starts_at, expires_at, metadata
     )
     SELECT
       $1::uuid,
       product,
       CASE product
         WHEN 'pms' THEN 'property-management'
         WHEN 'booking' THEN 'booking-engine'
         WHEN 'marketplace' THEN 'marketplace-hotel-profile'
       END,
       'active',
       $4::timestamptz,
       NULL,
       jsonb_build_object('source', $3::text)
     FROM unnest($2::text[]) AS product
     ON CONFLICT (
       organization_id,
       product,
       entitlement_key,
       COALESCE(resource_product, ''),
       COALESCE(resource_type, ''),
       COALESCE(resource_id, '')
     ) DO UPDATE SET
       status = 'active',
       starts_at = $4::timestamptz,
       expires_at = NULL,
       updated_at = $4::timestamptz
     WHERE identity.product_entitlements.metadata ->> 'source' = $3
       AND (
         identity.product_entitlements.status = 'expired'
         OR (
           identity.product_entitlements.status = 'active'
           AND (
             identity.product_entitlements.starts_at > $4::timestamptz
             OR identity.product_entitlements.expires_at <= $4::timestamptz
           )
         )
         OR (
           identity.product_entitlements.status = 'suspended'
           AND (
             identity.product_entitlements.expires_at <= $4::timestamptz
             OR identity.product_entitlements.starts_at > $4::timestamptz
           )
         )
       )`,
    [organizationId, missingEntitlements, SETUP_SOURCE, now.toISOString()],
  );
  await client.query(
    `INSERT INTO identity.organization_resource_links (
       organization_id, product, resource_type, resource_id, relationship, status
     )
     SELECT
       $1::uuid,
       requested.product,
       CASE requested.product
         WHEN 'pms' THEN 'pms_property'
         WHEN 'booking' THEN 'booking_hotel'
         WHEN 'marketplace' THEN 'hotel_profile'
       END,
       catalog.resource_id,
       catalog.relationship,
       'active'
     FROM identity.organization_resource_links catalog
     CROSS JOIN unnest($2::text[]) AS requested(product)
     JOIN hotel_catalog.properties property ON property.id::text = catalog.resource_id
     WHERE catalog.organization_id = $1::uuid
       AND catalog.product = 'hotel_catalog'
       AND catalog.resource_type = 'property'
       AND catalog.relationship IN ('owner', 'operator')
       AND catalog.status = 'active'
     ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
     DO NOTHING`,
    [organizationId, products],
  );
}

async function initializeProductRecords(
  client: PoolClient,
  organizationId: string,
  tracks: SetupTrack[],
): Promise<void> {
  if (tracks.includes("hotel_operations")) {
    await client.query(
      `INSERT INTO booking.booking_settings (property_id)
       SELECT link.resource_id::uuid
       FROM identity.organization_resource_links link
       WHERE link.organization_id = $1::uuid
         AND link.product = 'booking'
         AND link.resource_type = 'booking_hotel'
         AND link.status = 'active'
         AND EXISTS (
           SELECT 1
           FROM identity.organization_resource_links catalog
           WHERE catalog.organization_id = link.organization_id
             AND catalog.product = 'hotel_catalog'
             AND catalog.resource_type = 'property'
             AND catalog.resource_id = link.resource_id
             AND catalog.relationship = link.relationship
             AND catalog.status = 'active'
         )
       ON CONFLICT (property_id) DO NOTHING`,
      [organizationId],
    );
  }
  if (tracks.includes("creator_marketplace")) {
    await client.query(
      `INSERT INTO marketplace.marketplace_hotel_profiles (
         property_id, organization_id, source_system, source_hotel_profile_id
       )
       SELECT link.resource_id::uuid, $1::uuid, 'marketplace', link.resource_id
       FROM identity.organization_resource_links link
       WHERE link.organization_id = $1::uuid
         AND link.product = 'marketplace'
         AND link.resource_type = 'hotel_profile'
         AND link.status = 'active'
         AND EXISTS (
           SELECT 1
           FROM identity.organization_resource_links catalog
           WHERE catalog.organization_id = link.organization_id
             AND catalog.product = 'hotel_catalog'
             AND catalog.resource_type = 'property'
             AND catalog.resource_id = link.resource_id
             AND catalog.relationship = link.relationship
             AND catalog.status = 'active'
         )
       ON CONFLICT (property_id) DO NOTHING`,
      [organizationId],
    );
    const ownership = await client.query<{ complete: boolean }>(
      `SELECT NOT EXISTS (
         SELECT 1
         FROM identity.organization_resource_links link
         WHERE link.organization_id = $1::uuid
           AND link.product = 'marketplace'
           AND link.resource_type = 'hotel_profile'
           AND link.status = 'active'
           AND EXISTS (
             SELECT 1
             FROM identity.organization_resource_links catalog
             WHERE catalog.organization_id = link.organization_id
               AND catalog.product = 'hotel_catalog'
               AND catalog.resource_type = 'property'
               AND catalog.resource_id = link.resource_id
               AND catalog.relationship = link.relationship
               AND catalog.status = 'active'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM marketplace.marketplace_hotel_profiles profile
             WHERE profile.property_id = link.resource_id::uuid
               AND profile.organization_id = link.organization_id
           )
       ) AS complete`,
      [organizationId],
    );
    if (!ownership.rows[0]?.complete) {
      throw new Error("Marketplace profile ownership initialization failed");
    }
  }
}

function trackStatusResponse(
  intent: IntentRow | null,
  state: ProvisioningState,
  catalogLinks: CatalogLink[],
): UpdateTracksResponse {
  const selectedTracks = intent?.selectedTracks ?? [];
  return {
    trackRevision: intent?.revision ?? 0,
    selectedTracks,
    tracks: SETUP_TRACKS.map((track) => toTrackStatus(track, selectedTracks, state, catalogLinks)),
  };
}

function toTrackStatus(
  track: SetupTrack,
  selectedTracks: SetupTrack[],
  state: ProvisioningState,
  catalogLinks: CatalogLink[],
): TrackStatus {
  const selected = selectedTracks.includes(track);
  return {
    track,
    provisioning: !selected
      ? "not_selected"
      : trackIsActive(track, state, catalogLinks)
        ? "active"
        : "blocked",
    components: SETUP_TRACK_COMPONENT_PRODUCTS[track].map((product) => ({
      product,
      access: state.access[product],
    })),
    allowedActions: selected ? ["manage_service"] : ["add"],
  };
}

async function findReplay(
  client: PoolClient,
  command: HotelSetupTrackCommand,
  keyHash: string,
  fingerprint: string,
): Promise<HotelSetupTrackCommandResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT
       id,
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       response_status_code AS "responseStatusCode",
       response_body_hash AS "responseBodyHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'hotel_catalog'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'organization'
       AND organization_id = $3::uuid
     FOR UPDATE`,
    [OPERATION, keyHash, command.organizationId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return conflict("idempotency_key_conflict");
  }
  if (existing.status !== "completed") return conflict("command_in_progress");

  const stored = isRecord(existing.idempotencyMetadata)
    ? existing.idempotencyMetadata["result"]
    : null;
  const parsed = parseStoredHotelSetupTrackCommandResult(stored);
  if (!parsed) return conflict("idempotency_key_conflict");
  const expectedStatus = parsed.ok ? 200 : 409;
  const responseBody = parsed.ok ? parsed.response : parsed.error;
  if (
    existing.responseStatusCode !== expectedStatus ||
    existing.responseBodyHash !== sha256(canonicalJson(responseBody))
  ) {
    return conflict("idempotency_key_conflict");
  }
  return parsed;
}

async function reserveIdempotency(
  client: PoolClient,
  command: HotelSetupTrackCommand,
  keyHash: string,
  fingerprint: string,
  now: Date,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       tenant_scope,
       organization_id,
       correlation_id,
       expires_at
     )
     VALUES (
       'hotel_catalog',
       $1,
       $2,
       $3,
       'organization',
       $4::uuid,
       $5,
       $6::timestamptz + interval '24 hours'
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      OPERATION,
      keyHash,
      fingerprint,
      command.organizationId,
      command.audit.correlationId ?? command.audit.requestId,
      now.toISOString(),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function completeIdempotency(
  client: PoolClient,
  id: string,
  result: HotelSetupTrackCommandResult,
  now: Date,
): Promise<void> {
  const responseBody = result.ok ? result.response : result.error;
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = $2,
         response_body_hash = $3,
         completed_at = $4::timestamptz,
         last_seen_at = $4::timestamptz,
         idempotency_metadata = jsonb_build_object('result', $5::jsonb)
     WHERE id = $1::uuid
       AND status = 'in_progress'`,
    [
      id,
      result.ok ? 200 : 409,
      sha256(canonicalJson(responseBody)),
      now.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) throw new Error("Hotel setup idempotency completion failed");
}

async function recordAudit(
  client: PoolClient,
  input: {
    command: HotelSetupTrackCommand;
    idempotencyId: string;
    keyHash: string;
    previous: IntentRow | null;
    result: HotelSetupTrackCommandResult;
    occurredAt: Date;
  },
): Promise<void> {
  const after = input.result.ok
    ? {
        revision: input.result.response.trackRevision,
        selectedTracks: input.result.response.selectedTracks,
        tracks: input.result.response.tracks,
      }
    : {
        revision: input.previous?.revision ?? 0,
        selectedTracks: input.previous?.selectedTracks ?? [],
        error: input.result.error,
      };
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       occurred_at,
       tenant_scope,
       organization_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       idempotency_key_id,
       correlation_id,
       causation_id,
       redacted_payload,
       audit_metadata
     )
     VALUES (
       $1,
       'hotel_catalog',
       'hotel_setup.tracks.changed',
       $2::timestamptz,
       'organization',
       $3::uuid,
       'user',
       $4::uuid,
       'hotel_catalog',
       'organization_setup_track_intent',
       $3,
       $5::uuid,
       $6,
       $7,
       $8::jsonb,
       $9::jsonb
     )`,
    [
      `hotel_setup.tracks.organization.${input.command.organizationId}.key.${input.keyHash}.v1`,
      input.occurredAt.toISOString(),
      input.command.organizationId,
      input.command.actorUserId,
      input.idempotencyId,
      input.command.audit.correlationId ?? input.command.audit.requestId,
      input.command.audit.requestId,
      JSON.stringify({
        before: {
          revision: input.previous?.revision ?? 0,
          selectedTracks: input.previous?.selectedTracks ?? [],
        },
        requestedTracks: input.command.selectedTracks,
        expectedRevision: input.command.expectedRevision,
        after,
      }),
      JSON.stringify({
        source: input.command.audit.source,
        ...(input.command.adminActivation
          ? { adminActivation: input.command.adminActivation }
          : {}),
        requestId: input.command.audit.requestId,
      }),
    ],
  );
}

function conflict(
  code: SetupCommandError["code"],
  currentRevision?: number,
): HotelSetupTrackCommandResult {
  return {
    ok: false,
    error: { code, ...(currentRevision === undefined ? {} : { currentRevision }) },
  };
}

const SETUP_COMMAND_ERROR_CODES = [
  "track_revision_conflict",
  "track_removal_requires_service_management",
] as const satisfies readonly SetupCommandError["code"][];

export function parseStoredHotelSetupTrackCommandResult(
  value: unknown,
): HotelSetupTrackCommandResult | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, value["ok"] === true ? ["ok", "response"] : ["ok", "error"])
  ) {
    return null;
  }
  if (value["ok"] === true && isUpdateTracksResponse(value["response"])) {
    return { ok: true, response: value["response"] };
  }
  if (value["ok"] === false && isSetupCommandError(value["error"])) {
    return { ok: false, error: value["error"] };
  }
  return null;
}

function isUpdateTracksResponse(value: unknown): value is UpdateTracksResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["trackRevision", "selectedTracks", "tracks"]) ||
    !isRevision(value["trackRevision"], 1) ||
    !Array.isArray(value["selectedTracks"]) ||
    value["selectedTracks"].length === 0 ||
    value["selectedTracks"].some((track) => !isSetupTrack(track)) ||
    new Set(value["selectedTracks"]).size !== value["selectedTracks"].length ||
    !Array.isArray(value["tracks"]) ||
    value["tracks"].length !== SETUP_TRACKS.length
  ) {
    return false;
  }
  const selectedTracks = value["selectedTracks"] as SetupTrack[];
  const canonicalTracks = SETUP_TRACKS.filter((track) => selectedTracks.includes(track));
  return (
    sameTracks(selectedTracks, canonicalTracks) &&
    value["tracks"].every((track, index) =>
      isTrackStatus(track, SETUP_TRACKS[index]!, selectedTracks),
    )
  );
}

function isTrackStatus(
  value: unknown,
  expectedTrack: SetupTrack,
  selectedTracks: SetupTrack[],
): value is TrackStatus {
  const products = SETUP_TRACK_COMPONENT_PRODUCTS[expectedTrack];
  const selected = selectedTracks.includes(expectedTrack);
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["track", "provisioning", "components", "allowedActions"]) &&
    value["track"] === expectedTrack &&
    (selected
      ? value["provisioning"] === "active" || value["provisioning"] === "blocked"
      : value["provisioning"] === "not_selected") &&
    Array.isArray(value["components"]) &&
    value["components"].length === products.length &&
    value["components"].every(
      (component, index) =>
        isRecord(component) &&
        hasOnlyKeys(component, ["product", "access"]) &&
        component["product"] === products[index] &&
        ["absent", "active", "suspended", "unavailable"].includes(String(component["access"])),
    ) &&
    Array.isArray(value["allowedActions"]) &&
    value["allowedActions"].length === 1 &&
    value["allowedActions"][0] === (selected ? "manage_service" : "add")
  );
}

function isSetupCommandError(value: unknown): value is SetupCommandError {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["code", "currentRevision"]) &&
    (value["code"] === SETUP_COMMAND_ERROR_CODES[0] ||
      value["code"] === SETUP_COMMAND_ERROR_CODES[1]) &&
    isRevision(value["currentRevision"])
  );
}

function isRevision(value: unknown, minimum = 0): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= 2_147_483_647
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function sameTracks(left: SetupTrack[], right: SetupTrack[]): boolean {
  return left.length === right.length && left.every((track, index) => track === right[index]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Cannot canonicalize an undefined JSON value");
  return serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
