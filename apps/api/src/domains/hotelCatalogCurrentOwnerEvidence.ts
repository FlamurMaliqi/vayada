import {
  createHotelCatalogCurrentOwnerEvidence,
  parseHotelCatalogCurrentOwnerEvidenceScope,
  type HotelCatalogCurrentOwnerEvidenceScope,
  type HotelCatalogCurrentOwnerKey,
  type HotelCatalogLocationCurrentOwnerEvidencePort,
  type HotelCatalogPolicyCurrentOwnerEvidencePort,
} from "@vayada/domain-hotels";
import type { QueryResult, QueryResultRow } from "pg";

export type HotelCatalogCurrentOwnerEvidencePool = {
  readonly options: Readonly<{ connectionTimeoutMillis?: number }>;
  query<Row extends QueryResultRow = QueryResultRow>(
    config: Readonly<{ text: string; values: unknown[]; query_timeout: number }>,
  ): Promise<QueryResult<Row>>;
};

export type HotelCatalogCurrentOwnerEvidencePorts = Readonly<{
  location: HotelCatalogLocationCurrentOwnerEvidencePort;
  policy: HotelCatalogPolicyCurrentOwnerEvidencePort;
}>;

type OwnerRow = QueryResultRow & {
  propertyId: string;
  ownerPropertyId: string | null;
  revision: string | null;
};

const OWNER_READ_TIMEOUT_MS = 5_000;

export function createPgHotelCatalogCurrentOwnerEvidencePorts(options: {
  pool: HotelCatalogCurrentOwnerEvidencePool;
}): HotelCatalogCurrentOwnerEvidencePorts {
  const connectionTimeoutMillis = options.pool.options.connectionTimeoutMillis;
  if (
    typeof connectionTimeoutMillis !== "number" ||
    !Number.isFinite(connectionTimeoutMillis) ||
    connectionTimeoutMillis <= 0 ||
    connectionTimeoutMillis > OWNER_READ_TIMEOUT_MS
  ) {
    throw new Error("Hotel Catalog current-owner evidence pool requires a bounded checkout");
  }
  return Object.freeze({
    location: Object.freeze({
      ownerKey: "hotel_catalog.location" as const,
      getCurrentLocationOwnerEvidence: (scope: HotelCatalogCurrentOwnerEvidenceScope) =>
        readOwner(options.pool, scope, "hotel_catalog.location"),
    }),
    policy: Object.freeze({
      ownerKey: "hotel_catalog.policy" as const,
      getCurrentPolicyOwnerEvidence: (scope: HotelCatalogCurrentOwnerEvidenceScope) =>
        readOwner(options.pool, scope, "hotel_catalog.policy"),
    }),
  });
}

async function readOwner<Key extends HotelCatalogCurrentOwnerKey>(
  pool: HotelCatalogCurrentOwnerEvidencePool,
  input: HotelCatalogCurrentOwnerEvidenceScope,
  ownerKey: Key,
) {
  const scope = parseHotelCatalogCurrentOwnerEvidenceScope(input);
  if (!scope) return Object.freeze({ outcome: "malformed" as const });
  try {
    const result = await pool.query<OwnerRow>({
      text: ownerSql(ownerKey),
      values: [scope.organizationId, scope.propertyId],
      query_timeout: OWNER_READ_TIMEOUT_MS,
    });
    const row = result.rows[0];
    if (!row)
      return Object.freeze({ outcome: "missing" as const, reason: "property_scope" as const });
    if (row.propertyId !== scope.propertyId)
      return Object.freeze({ outcome: "malformed" as const });
    if (row.ownerPropertyId === null)
      return Object.freeze({ outcome: "missing" as const, reason: "owner_state" as const });
    if (row.ownerPropertyId !== scope.propertyId || !revision(row.revision))
      return Object.freeze({ outcome: "malformed" as const });
    const evidence = createHotelCatalogCurrentOwnerEvidence(ownerKey, scope, Number(row.revision));
    return evidence
      ? Object.freeze({ outcome: "available" as const, evidence })
      : Object.freeze({ outcome: "malformed" as const });
  } catch {
    return Object.freeze({ outcome: "unavailable" as const, errorSource: "system" as const });
  }
}

function ownerSql(ownerKey: HotelCatalogCurrentOwnerKey): string {
  const ownerJoin =
    ownerKey === "hotel_catalog.location"
      ? "hotel_catalog.property_locations owner ON owner.property_id = property.id"
      : "hotel_catalog.property_policy_summaries owner ON owner.property_id = property.id";
  return `
    SELECT property.id::text AS "propertyId",
           owner.property_id::text AS "ownerPropertyId",
           revision.revision::text AS revision
    FROM hotel_catalog.properties property
    JOIN identity.organizations organization
      ON organization.id = $1::uuid
     AND organization.kind = 'hotel_group'
     AND organization.status = 'active'
    LEFT JOIN ${ownerJoin}
    LEFT JOIN hotel_catalog.property_owner_revisions revision
      ON revision.property_id = property.id
     AND revision.owner_key = '${ownerKey}'
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
    LIMIT 1
  `;
}

function revision(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647;
}
