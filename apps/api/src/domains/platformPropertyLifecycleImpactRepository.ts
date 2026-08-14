import {
  PLATFORM_PROPERTY_LIFECYCLE_CONTRACT_VERSION,
  type PlatformPropertyImpactBlocker,
  type PlatformPropertyRetirementImpact,
} from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PlatformPropertyLifecycleQuery = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export type PlatformPropertyLifecycleImpactRepository = {
  getRetirementImpact(propertyId: string): Promise<PlatformPropertyRetirementImpact | null>;
  close(): Promise<void>;
};

type ImpactRow = {
  propertyId: string;
  lifecycleStatus: PlatformPropertyRetirementImpact["lifecycleStatus"];
  lifecycleRevision: number | string;
  linkedOrganizations: number | string;
  activeEntitlements: number | string;
  suspendedEntitlements: number | string;
  totalBookings: number | string;
  activeBookings: number | string;
  roomTypes: number | string;
  rooms: number | string;
  totalPayments: number | string;
  unresolvedPayments: number | string;
  totalPayouts: number | string;
  openPayouts: number | string;
  billingEntitlements: number | string;
  mediaObjects: number | string;
  marketplaceActive: boolean;
  distributionStatus: string | null;
  bookingRevisionActive: boolean;
  connectedChannels: number | string;
};

export function createPgPlatformPropertyLifecycleImpactRepository(config: {
  connectionString?: string;
  pool?: PlatformPropertyLifecycleQuery & { end(): Promise<void> };
}): PlatformPropertyLifecycleImpactRepository {
  if (!config.pool && !config.connectionString?.trim()) {
    throw new Error("Platform property lifecycle connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString });
  return {
    getRetirementImpact: (propertyId) => readPlatformPropertyRetirementImpact(pool, propertyId),
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

export async function readPlatformPropertyRetirementImpact(
  query: PlatformPropertyLifecycleQuery,
  propertyId: string,
  lock = false,
): Promise<PlatformPropertyRetirementImpact | null> {
  const result = await query.query<ImpactRow>(impactSql(lock), [propertyId]);
  const row = result.rows[0];
  if (!row) return null;
  const counts = {
    linkedOrganizations: integer(row.linkedOrganizations),
    activeEntitlements: integer(row.activeEntitlements),
    suspendedEntitlements: integer(row.suspendedEntitlements),
    totalBookings: integer(row.totalBookings),
    activeBookings: integer(row.activeBookings),
    roomTypes: integer(row.roomTypes),
    rooms: integer(row.rooms),
    totalPayments: integer(row.totalPayments),
    unresolvedPayments: integer(row.unresolvedPayments),
    totalPayouts: integer(row.totalPayouts),
    openPayouts: integer(row.openPayouts),
    billingEntitlements: integer(row.billingEntitlements),
    mediaObjects: integer(row.mediaObjects),
    connectedChannels: integer(row.connectedChannels),
  };
  const blockers: PlatformPropertyImpactBlocker[] = [
    blocker("active_bookings", "booking", counts.activeBookings, "Resolve active bookings."),
    blocker(
      "unresolved_payments",
      "finance",
      counts.unresolvedPayments,
      "Resolve pending or disputed payments.",
    ),
    blocker("open_payouts", "finance", counts.openPayouts, "Resolve open payouts."),
    blocker(
      "connected_channels",
      "pms",
      counts.connectedChannels,
      "Disconnect active channel-manager connections.",
    ),
  ].filter((item) => item.count > 0);

  return {
    contractVersion: PLATFORM_PROPERTY_LIFECYCLE_CONTRACT_VERSION,
    propertyId: row.propertyId,
    lifecycleStatus: row.lifecycleStatus,
    lifecycleRevision: integer(row.lifecycleRevision),
    organizations: { linked: counts.linkedOrganizations },
    entitlements: {
      active: counts.activeEntitlements,
      suspended: counts.suspendedEntitlements,
    },
    bookings: { total: counts.totalBookings, active: counts.activeBookings },
    inventory: { roomTypes: counts.roomTypes, rooms: counts.rooms },
    finance: {
      totalPayments: counts.totalPayments,
      unresolvedPayments: counts.unresolvedPayments,
      totalPayouts: counts.totalPayouts,
      openPayouts: counts.openPayouts,
      billingEntitlements: counts.billingEntitlements,
    },
    media: { objects: counts.mediaObjects },
    publicExposure: {
      marketplaceActive: row.marketplaceActive,
      distributionStatus: row.distributionStatus,
      bookingRevisionActive: row.bookingRevisionActive,
    },
    blockers,
    canRetire: blockers.length === 0 && row.lifecycleStatus !== "retired",
    hardDeletion: { allowed: false, reason: "hard_delete_not_supported" },
  };
}

function blocker(
  code: PlatformPropertyImpactBlocker["code"],
  ownerDomain: PlatformPropertyImpactBlocker["ownerDomain"],
  count: number,
  message: string,
): PlatformPropertyImpactBlocker {
  return { code, ownerDomain, count, message };
}

function integer(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error("Invalid lifecycle impact count");
  return parsed;
}

function impactSql(lock: boolean): string {
  return `
    WITH property AS (
      SELECT id, lifecycle_status, lifecycle_revision
      FROM hotel_catalog.properties
      WHERE id = $1::uuid
      ${lock ? "FOR UPDATE" : ""}
    ), linked_organizations AS (
      SELECT DISTINCT link.organization_id
      FROM identity.organization_resource_links link, property
      WHERE link.resource_id = property.id::text
        AND link.status <> 'archived'
    )
    SELECT property.id::text AS "propertyId",
      property.lifecycle_status AS "lifecycleStatus",
      property.lifecycle_revision AS "lifecycleRevision",
      (SELECT count(*) FROM linked_organizations) AS "linkedOrganizations",
      (SELECT count(*) FROM identity.product_entitlements entitlement
       WHERE entitlement.organization_id IN (SELECT organization_id FROM linked_organizations)
         AND (entitlement.resource_id IS NULL OR entitlement.resource_id = property.id::text)
         AND entitlement.status = 'active') AS "activeEntitlements",
      (SELECT count(*) FROM identity.product_entitlements entitlement
       WHERE entitlement.organization_id IN (SELECT organization_id FROM linked_organizations)
         AND (entitlement.resource_id IS NULL OR entitlement.resource_id = property.id::text)
         AND entitlement.status = 'suspended') AS "suspendedEntitlements",
      (SELECT count(*) FROM booking.guest_bookings booking
       WHERE booking.property_id = property.id) AS "totalBookings",
      (SELECT count(*) FROM booking.guest_bookings booking
       WHERE booking.property_id = property.id
         AND booking.lifecycle_status IN ('draft', 'pending_payment', 'confirmed')) AS "activeBookings",
      (SELECT count(*) FROM pms.room_types room_type
       WHERE room_type.property_id = property.id) AS "roomTypes",
      (SELECT count(*) FROM pms.rooms room
       WHERE room.property_id = property.id) AS rooms,
      (SELECT count(*) FROM finance.payments payment
       WHERE payment.property_id = property.id) AS "totalPayments",
      (SELECT count(*) FROM finance.payments payment
       WHERE payment.property_id = property.id
         AND payment.status IN ('requires_action', 'authorized', 'pending', 'disputed'))
        AS "unresolvedPayments",
      (SELECT count(*) FROM finance.payouts payout
       WHERE payout.property_id = property.id OR payout.related_property_id = property.id)
        AS "totalPayouts",
      (SELECT count(*) FROM finance.payouts payout
       WHERE (payout.property_id = property.id OR payout.related_property_id = property.id)
         AND payout.payout_status IN ('pending', 'scheduled', 'processing', 'failed'))
        AS "openPayouts",
      (SELECT count(*) FROM finance.billing_entitlements billing
       WHERE billing.property_id = property.id) AS "billingEntitlements",
      (SELECT count(*) FROM platform.media_objects media
       WHERE media.property_id = property.id AND media.lifecycle_status <> 'deleted')
        AS "mediaObjects",
      EXISTS (SELECT 1 FROM marketplace.active_hotel_submission_revisions marketplace
       WHERE marketplace.property_id = property.id AND marketplace.activation_status = 'active')
      OR EXISTS (SELECT 1 FROM marketplace.marketplace_offer_read_model offer
       WHERE offer.property_id = property.id AND offer.visibility_status = 'public')
        AS "marketplaceActive",
      (SELECT profile.profile_status FROM distribution.public_hotel_bookability_profiles profile
       WHERE profile.property_id = property.id) AS "distributionStatus",
      EXISTS (SELECT 1 FROM distribution.active_public_booking_revision booking_revision
       WHERE booking_revision.property_id = property.id) AS "bookingRevisionActive",
      (SELECT count(*) FROM pms.channel_connections connection
       WHERE connection.property_id = property.id
         AND connection.connection_status IN ('connected', 'degraded')) AS "connectedChannels"
    FROM property`;
}
