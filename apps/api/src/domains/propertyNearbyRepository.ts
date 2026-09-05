import { randomUUID } from "node:crypto";
import {
  checkNearbyCurationWrite,
  parseNearbyCurationWrite,
  type NearbyCurationState,
  type NearbyWriteError,
} from "@vayada/domain-hotels";
import pg from "pg";

export type NearbyScope = { organizationId: string; propertyId: string };
export type NearbySaveResult =
  | { ok: true; state: NearbyCurationState }
  | { ok: false; code: NearbyWriteError | "missing_property_resource_link" };
export type PropertyNearbyRepository = {
  read(scope: NearbyScope): Promise<NearbyCurationState | null>;
  save(
    scope: NearbyScope & { actorUserId: string; requestId: string },
    input: unknown,
  ): Promise<NearbySaveResult>;
  close(): Promise<void>;
};

export function createPgPropertyNearbyRepository(
  connectionString: string,
): PropertyNearbyRepository {
  const pool = new pg.Pool({ connectionString });
  return {
    async read(scope) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const state = await lockState(client, scope);
        await client.query("COMMIT");
        return state;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async save(scope, input) {
      const parsed = parseNearbyCurationWrite(input);
      if (!parsed.ok) return parsed;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await lockState(client, scope);
        if (!current) {
          await client.query("ROLLBACK");
          return { ok: false, code: "missing_property_resource_link" };
        }
        // Discovery registration arrives in VAY-1476. Until then, no new Google
        // reference is trusted; manual places and validated saved choices work.
        const code = checkNearbyCurationWrite(parsed.value, current, new Set());
        if (code) {
          await client.query("ROLLBACK");
          return { ok: false, code };
        }
        const state: NearbyCurationState = {
          schemaVersion: 1,
          profileRevision: current.profileRevision,
          curationRevision: current.curationRevision + 1,
          savedProfileRevision: current.profileRevision,
          choices: parsed.value.choices,
          customPlaces: parsed.value.customPlaces,
        };
        await client.query(
          `INSERT INTO hotel_catalog.property_nearby_curation
          (property_id, revision, saved_profile_revision, choices, custom_places)
          VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb)
          ON CONFLICT (property_id) DO UPDATE SET revision=EXCLUDED.revision,
          saved_profile_revision=EXCLUDED.saved_profile_revision, choices=EXCLUDED.choices,
          custom_places=EXCLUDED.custom_places, updated_at=now()`,
          [
            scope.propertyId,
            state.curationRevision,
            state.savedProfileRevision,
            JSON.stringify(state.choices),
            JSON.stringify(state.customPlaces),
          ],
        );
        await client.query(
          `INSERT INTO platform.product_audit_events
          (audit_key, product, action, tenant_scope, organization_id, actor_type,
           actor_user_id, target_resource_product, target_resource_type, target_resource_id,
           correlation_id, redacted_payload, privacy_scope, occurred_at)
          VALUES ($1, 'hotel_catalog', 'property.nearby.saved', 'organization', $2::uuid,
            'user', $3::uuid, 'hotel_catalog', 'property', $4, $5, $6::jsonb, 'confidential', now())`,
          [
            randomUUID(),
            scope.organizationId,
            scope.actorUserId,
            scope.propertyId,
            scope.requestId,
            JSON.stringify({
              previousRevision: current.curationRevision,
              revision: state.curationRevision,
              profileRevision: state.profileRevision,
              choiceCount: state.choices.length,
              customPlaceCount: state.customPlaces.length,
            }),
          ],
        );
        await client.query("COMMIT");
        return { ok: true, state };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function lockState(
  client: pg.PoolClient,
  scope: NearbyScope,
): Promise<NearbyCurationState | null> {
  // Shared profile writes lock this same property row. Lock the resource link
  // too so revocation cannot race a save after the route's authorization check.
  const property = await client.query<{ profile_revision: string }>(
    `
    SELECT p.profile_revision FROM hotel_catalog.properties p
    JOIN identity.organization_resource_links l ON l.resource_id=p.id::text
    WHERE p.id=$1::uuid AND l.organization_id=$2::uuid AND l.product='hotel_catalog'
      AND l.resource_type='property' AND l.status='active' AND l.relationship IN ('owner','operator')
    FOR UPDATE OF p FOR SHARE OF l`,
    [scope.propertyId, scope.organizationId],
  );
  if (!property.rows.length) return null;
  const profileRevision = Number(property.rows[0].profile_revision);
  const result = await client.query(
    `SELECT revision, saved_profile_revision, choices, custom_places
    FROM hotel_catalog.property_nearby_curation WHERE property_id=$1::uuid`,
    [scope.propertyId],
  );
  const row = result.rows[0];
  if (!row)
    return {
      schemaVersion: 1,
      profileRevision,
      curationRevision: 0,
      savedProfileRevision: null,
      choices: [],
      customPlaces: [],
    };
  const parsed = parseNearbyCurationWrite({
    schemaVersion: 1,
    expectedProfileRevision: profileRevision,
    expectedCurationRevision: Number(row.revision),
    choices: row.choices,
    customPlaces: row.custom_places,
  });
  if (!parsed.ok) throw new Error("Stored nearby curation is invalid");
  return {
    schemaVersion: 1,
    profileRevision,
    curationRevision: Number(row.revision),
    savedProfileRevision: Number(row.saved_profile_revision),
    choices: parsed.value.choices,
    customPlaces: parsed.value.customPlaces,
  };
}
