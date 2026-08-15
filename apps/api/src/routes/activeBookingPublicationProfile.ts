import type { PublicBookabilityProfileProjection } from "@vayada/domain-distribution";
import { parseBookingPublicContent } from "@vayada/domain-distribution/booking-publication";
import pg, { type QueryResultRow } from "pg";

import type { PublicHotelProfileReadPool, PublicHotelProfileRepository } from "./aiHotels.js";

type ActiveProfileRow = QueryResultRow & { propertyId: string; publicContent: unknown };

const ACTIVE_PROFILE_SELECT = `SELECT
  active.property_id::text AS "propertyId",
  revision.public_content AS "publicContent"
FROM distribution.active_public_booking_revision active
JOIN distribution.public_booking_content_revisions revision
  ON revision.id = active.content_revision_id
 AND revision.property_id = active.property_id
WHERE revision.public_content ->> 'contractVersion' = 'booking-public-content.v1'`;

export function createActiveBookingPublicationProfileRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PublicHotelProfileReadPool;
}): PublicHotelProfileRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Active Booking publication profile connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async findProfileBySlug(value) {
      const slug = normalizedSlug(value);
      if (!slug) return null;
      const result = await pool.query<ActiveProfileRow>(
        `${ACTIVE_PROFILE_SELECT}
         AND (
           lower(revision.public_content #>> '{profile,hotel,slug}') = $1
           OR EXISTS (
             SELECT 1
             FROM hotel_catalog.property_slugs redirect
             WHERE redirect.property_id = active.property_id
               AND redirect.slug = $1
               AND redirect.purpose = 'redirect'
               AND redirect.status = 'redirected'
           )
         )
         ORDER BY CASE
           WHEN lower(revision.public_content #>> '{profile,hotel,slug}') = $1 THEN 0
           ELSE 1
         END
         LIMIT 1`,
        [slug],
      );
      return currentActiveProfile(pool, result.rows[0]);
    },

    async findProfileByCustomDomain(value) {
      const domain = normalizedDomain(value);
      if (!domain) return null;
      const result = await pool.query<ActiveProfileRow>(
        `${ACTIVE_PROFILE_SELECT}
         AND EXISTS (
           SELECT 1
           FROM hotel_catalog.property_domains current_domain
           WHERE current_domain.property_id = active.property_id
             AND current_domain.hostname = $1
             AND current_domain.verification_status = 'verified'
             AND current_domain.canonical_when_verified = TRUE
         )
         LIMIT 1`,
        [domain],
      );
      const profile = activeProfile(result.rows[0]);
      return profile && normalizedDomain(profile.hotel.customDomainUrl ?? "") === domain
        ? profile
        : null;
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

function activeProfile(
  row: ActiveProfileRow | undefined,
): PublicBookabilityProfileProjection | null {
  if (!row) return null;
  const profile = parseBookingPublicContent(row.publicContent)?.profile;
  return profile &&
    profile.hotel.propertyId === row.propertyId &&
    profile.hotel.trust.bookabilityStatus === "bookable" &&
    profile.freshness.status === "fresh"
    ? profile
    : null;
}

async function currentActiveProfile(
  pool: PublicHotelProfileReadPool,
  row: ActiveProfileRow | undefined,
): Promise<PublicBookabilityProfileProjection | null> {
  const profile = activeProfile(row);
  if (!profile?.hotel.customDomainUrl || !row) return profile;
  const domain = normalizedDomain(profile.hotel.customDomainUrl);
  if (!domain) return null;
  const result = await pool.query<QueryResultRow & { verified: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM hotel_catalog.property_domains current_domain
       WHERE current_domain.property_id = $1::uuid
         AND current_domain.hostname = $2
         AND current_domain.verification_status = 'verified'
         AND current_domain.canonical_when_verified = TRUE
     ) AS verified`,
    [row.propertyId, domain],
  );
  return result.rows[0]?.verified === true ? profile : null;
}

const normalizedSlug = (value: string) => {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : null;
};

const normalizedDomain = (value: string) => {
  try {
    const input = value.trim();
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      hostname &&
      !hostname.includes("..") &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)
      ? hostname
      : null;
  } catch {
    return null;
  }
};
