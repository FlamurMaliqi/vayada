import { randomUUID } from "node:crypto";
import pg from "pg";
import type { NearbyCategory } from "@vayada/domain-hotels";
import {
  NEARBY_POLICY_VERSION,
  type NearbyDiscoveryResult,
  type NearbyOrigin,
} from "../integrations/googleNearbyPlaces.js";
import type { NearbyScope } from "./propertyNearbyRepository.js";

export type NearbyReference = { placeId: string; category: NearbyCategory };
export type NearbyDiscoveryState = {
  schemaVersion: 1;
  profileRevision: number;
  status: NearbyDiscoveryResult["status"] | "refreshing" | "stale";
  places: NearbyReference[];
  retryAfter: string | null;
};
export type NearbyClaim =
  | { status: "claimed"; token: string; origin: NearbyOrigin; profileRevision: number }
  | { status: "state"; state: NearbyDiscoveryState }
  | { status: "revision_conflict" | "cooldown"; retryAfter?: string }
  | { status: "missing_property_resource_link" };
type Row = {
  profile_revision: string;
  policy_version: string;
  status: NearbyDiscoveryResult["status"] | "refreshing";
  places: NearbyReference[];
  valid_until: Date | null;
  retry_after: Date;
  explicit_refresh_after: Date | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
};
type Current = {
  profileRevision: number;
  origin: NearbyOrigin | null;
  row: Row | undefined;
  now: Date;
};
export type PropertyNearbyDiscoveryRepository = ReturnType<
  typeof createPgPropertyNearbyDiscoveryRepository
>;

export function createPgPropertyNearbyDiscoveryRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  async function transaction<T>(
    scope: NearbyScope,
    work: (client: pg.PoolClient, current: Current | null) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const property = await client.query(
        `SELECT p.profile_revision FROM hotel_catalog.properties p
         JOIN identity.organization_resource_links l ON l.resource_id=p.id::text
         WHERE p.id=$1::uuid AND l.organization_id=$2::uuid AND l.product='hotel_catalog'
           AND l.resource_type='property' AND l.status='active' AND l.relationship IN ('owner','operator')
         FOR UPDATE OF p FOR SHARE OF l`,
        [scope.propertyId, scope.organizationId],
      );
      let current: Current | null = null;
      if (property.rows.length) {
        const location = await client.query<NearbyOrigin>(
          `SELECT CASE WHEN map_display_mode='approximate' THEN round(latitude,2) ELSE latitude END::double precision AS latitude,
           CASE WHEN map_display_mode='approximate' THEN round(longitude,2) ELSE longitude END::double precision AS longitude
           FROM hotel_catalog.property_locations WHERE property_id=$1::uuid AND geo_public=true
             AND map_display_mode IN ('exact','approximate') AND latitude IS NOT NULL AND longitude IS NOT NULL`,
          [scope.propertyId],
        );
        const stored = await client.query<Row>(
          "SELECT * FROM hotel_catalog.property_nearby_discovery WHERE property_id=$1::uuid",
          [scope.propertyId],
        );
        current = {
          profileRevision: Number(property.rows[0].profile_revision),
          now: (await client.query("SELECT clock_timestamp() AS now")).rows[0].now,
          origin: location.rows[0] ?? null,
          row: stored.rows[0],
        };
      }
      const result = await work(client, current);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    read: (scope: NearbyScope) =>
      transaction(scope, async (_client, current) => (current ? state(current) : null)),
    claim: (
      scope: NearbyScope,
      expectedProfileRevision: number,
      force = false,
    ): Promise<NearbyClaim> =>
      transaction(scope, async (client, current) => {
        if (!current) return { status: "missing_property_resource_link" };
        if (current.profileRevision !== expectedProfileRevision)
          return { status: "revision_conflict" };
        const view = state(current);
        if (
          !current.origin ||
          view.status === "refreshing" ||
          (!force && ["ready", "empty"].includes(view.status))
        )
          return { status: "state", state: view };
        if (
          force &&
          current.row?.explicit_refresh_after &&
          current.row.explicit_refresh_after > current.now
        )
          return {
            status: "cooldown",
            retryAfter: current.row.explicit_refresh_after.toISOString(),
          };
        // Property-wide cooldown survives location changes and protects paid calls.
        if (current.row && current.row.retry_after > current.now)
          return { status: "cooldown", retryAfter: current.row.retry_after.toISOString() };
        const token = randomUUID();
        await client.query(
          `INSERT INTO hotel_catalog.property_nearby_discovery
           (property_id,profile_revision,policy_version,status,lease_token,lease_expires_at,retry_after,explicit_refresh_after)
           VALUES ($1,$2,$3,'refreshing',$4,clock_timestamp()+interval '30 seconds',clock_timestamp()+interval '15 minutes',CASE WHEN $5 THEN clock_timestamp()+interval '1 hour' ELSE NULL END)
           ON CONFLICT(property_id) DO UPDATE SET profile_revision=EXCLUDED.profile_revision,
           policy_version=EXCLUDED.policy_version,status='refreshing',places='[]'::jsonb,
           fetched_at=NULL,valid_until=NULL,lease_token=EXCLUDED.lease_token,
           lease_expires_at=EXCLUDED.lease_expires_at,retry_after=EXCLUDED.retry_after,
           explicit_refresh_after=COALESCE(EXCLUDED.explicit_refresh_after,property_nearby_discovery.explicit_refresh_after)`,
          [scope.propertyId, current.profileRevision, NEARBY_POLICY_VERSION, token, force],
        );
        return {
          status: "claimed",
          token,
          origin: current.origin,
          profileRevision: current.profileRevision,
        };
      }),
    complete: (
      scope: NearbyScope,
      token: string,
      profileRevision: number,
      result: NearbyDiscoveryResult,
    ) =>
      transaction(scope, async (client, current): Promise<NearbyDiscoveryState | null> => {
        if (!current) return null;
        // An old request cannot publish after a source change or a replacement lease.
        if (
          current.profileRevision !== profileRevision ||
          current.row?.lease_token !== token ||
          !current.row.lease_expires_at ||
          current.row.lease_expires_at <= current.now ||
          !current.origin
        )
          return state(current);
        const ready = result.status === "ready" || result.status === "empty";
        const status =
          result.status === "not_configured" || result.status === "location_required"
            ? "provider_unavailable"
            : result.status;
        const places = ready
          ? result.places.map(({ placeId, category }) => ({ placeId, category }))
          : [];
        await client.query(
          `UPDATE hotel_catalog.property_nearby_discovery SET status=$2,places=$3::jsonb,
           fetched_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
           valid_until=CASE WHEN $4 THEN clock_timestamp()+interval '24 hours' ELSE NULL END,
           retry_after=clock_timestamp()+CASE WHEN $4 THEN interval '1 hour' ELSE interval '15 minutes' END,
           lease_token=NULL,lease_expires_at=NULL WHERE property_id=$1`,
          [scope.propertyId, status, JSON.stringify(places), ready],
        );
        const stored = await client.query<Row>(
          "SELECT * FROM hotel_catalog.property_nearby_discovery WHERE property_id=$1",
          [scope.propertyId],
        );
        return state({ ...current, row: stored.rows[0] });
      }),
    close: () => pool.end(),
  };
}
function state({ profileRevision, origin, row, now }: Current): NearbyDiscoveryState {
  const base = {
    schemaVersion: 1 as const,
    profileRevision,
    places: [] as NearbyReference[],
    retryAfter: row?.retry_after.toISOString() ?? null,
  };
  if (!origin) return { ...base, status: "location_required" };
  if (
    !row ||
    Number(row.profile_revision) !== profileRevision ||
    row.policy_version !== NEARBY_POLICY_VERSION
  )
    return { ...base, status: "stale" };
  if (row.status === "refreshing")
    return {
      ...base,
      status: row.lease_expires_at && row.lease_expires_at > now ? "refreshing" : "stale",
    };
  if (row.status === "ready" || row.status === "empty")
    return row.valid_until && row.valid_until > now
      ? { ...base, status: row.status, places: row.places }
      : { ...base, status: "stale" };
  return { ...base, status: row.status };
}
