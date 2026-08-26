import type { BookingGuestPolicyCatalogProfileEvidencePort } from "@vayada/domain-booking";
import { getTimezone } from "countries-and-timezones";
import type { QueryResult, QueryResultRow } from "pg";

export type BookingGuestPolicyCatalogProfileEvidencePool = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
};

type ProfileRow = {
  propertyId: string;
  profileRevision: string | number;
  timeZone: unknown;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createBookingGuestPolicyCatalogProfileEvidencePort(config: {
  pool: BookingGuestPolicyCatalogProfileEvidencePool;
}): BookingGuestPolicyCatalogProfileEvidencePort {
  return Object.freeze({
    bookingGuestPolicyCatalogProfileEvidencePort: "hotel_catalog" as const,
    async getCatalogProfileEvidence(input: { organizationId: string; propertyId: string }) {
      if (!UUID_PATTERN.test(input.organizationId) || !UUID_PATTERN.test(input.propertyId)) {
        return Object.freeze({ outcome: "malformed" as const });
      }
      try {
        const result = await config.pool.query<ProfileRow>(
          `SELECT property.id::text AS "propertyId",
                  property.profile_revision AS "profileRevision",
                  location.timezone AS "timeZone"
             FROM hotel_catalog.properties property
             JOIN identity.organizations organization
               ON organization.id = $1::uuid
              AND organization.kind = 'hotel_group'
              AND organization.status = 'active'
        LEFT JOIN hotel_catalog.property_locations location
               ON location.property_id = property.id
            WHERE property.id = $2::uuid
              AND EXISTS (
                SELECT 1
                  FROM identity.organization_resource_links resource
                 WHERE resource.organization_id = organization.id
                   AND resource.product = 'hotel_catalog'
                   AND resource.resource_type = 'property'
                   AND resource.resource_id = property.id::text
                   AND resource.relationship IN ('owner', 'operator')
                   AND resource.status = 'active'
              )
            /* booking_guest_policy_catalog_profile_scope */`,
          [input.organizationId.toLowerCase(), input.propertyId.toLowerCase()],
        );
        if (result.rows.length > 1) return Object.freeze({ outcome: "malformed" as const });
        const row = result.rows[0];
        if (!row)
          return Object.freeze({
            outcome: "unavailable" as const,
            errorSource: "provider" as const,
          });
        const revision = positiveRevision(row.profileRevision);
        if (revision === null) return Object.freeze({ outcome: "malformed" as const });
        const source = Object.freeze({
          ownerDomain: "hotel_catalog" as const,
          entityType: "property_profile" as const,
          entityId: input.propertyId.toLowerCase(),
          revision: `profile:${revision}`,
        });
        if (row.propertyId !== source.entityId)
          return Object.freeze({ outcome: "malformed" as const });
        if (row.timeZone === null || row.timeZone === "") {
          return Object.freeze({ outcome: "timezone_missing" as const, source });
        }
        if (typeof row.timeZone !== "string" || !canonicalTimeZone(row.timeZone)) {
          return Object.freeze({ outcome: "timezone_invalid" as const, source });
        }
        return Object.freeze({
          outcome: "available" as const,
          evidence: Object.freeze({ source, timeZone: row.timeZone }),
        });
      } catch {
        return Object.freeze({ outcome: "unavailable" as const, errorSource: "system" as const });
      }
    },
  });
}

function positiveRevision(value: string | number): number | null {
  const revision = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(revision) &&
    revision >= 1 &&
    revision <= 2_147_483_647 &&
    (typeof value === "number" || /^[1-9][0-9]*$/.test(value))
    ? revision
    : null;
}

function canonicalTimeZone(value: string): boolean {
  try {
    const zone = getTimezone(value);
    return zone !== null && zone.name === value && zone.aliasOf === null;
  } catch {
    return false;
  }
}
