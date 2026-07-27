import type {
  LinkedResource,
  PermissionKey,
  Product,
  ProductEntitlement,
  ResourceType,
} from "@vayada/backend-auth";
import { isOpaqueHotelSetupHandoffCode, type SetupTaskId } from "@vayada/domain-hotels";
import { createHash, randomBytes } from "node:crypto";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type HotelSetupHandoffBinding = {
  internalUserId: string;
  providerSessionId: string;
  organizationId: string;
  membershipId: string;
};

export type StoredHotelSetupHandoff = HotelSetupHandoffBinding & {
  id: string;
  propertyId: string;
  taskId: SetupTaskId;
  issuedPlanRevision: string;
  destinationRouteKey: string;
  returnUrl: string;
  expiresAt: string;
};

export type HotelSetupHandoffAccessSnapshot = {
  permissions: PermissionKey[];
  linkedResources: LinkedResource[];
  entitlements: ProductEntitlement[];
};

export type ConsumedHotelSetupHandoff = StoredHotelSetupHandoff & {
  access: HotelSetupHandoffAccessSnapshot;
};

export type HotelSetupHandoffRepository = {
  issue(input: {
    binding: HotelSetupHandoffBinding;
    propertyId: string;
    taskId: SetupTaskId;
    issuedPlanRevision: string;
    destinationRouteKey: string;
    returnUrl: string;
  }): Promise<{ code: string; expiresAt: string }>;
  findActive(code: string): Promise<StoredHotelSetupHandoff | null>;
  consume(input: {
    id: string;
    code: string;
    binding: HotelSetupHandoffBinding;
  }): Promise<ConsumedHotelSetupHandoff | null>;
  close(): Promise<void>;
};

export type HotelSetupHandoffQueryPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  end(): Promise<void>;
};

type HotelSetupHandoffRow = {
  id: string;
  internalUserId: string;
  providerSessionId: string;
  organizationId: string;
  membershipId: string;
  propertyId: string;
  taskId: SetupTaskId;
  issuedPlanRevision: string;
  destinationRouteKey: string;
  returnUrl: string;
  expiresAt: Date | string;
};

type HotelSetupHandoffEntitlementRow = {
  product: Product;
  key: string;
  status: ProductEntitlement["status"];
  resourceProduct: Product | null;
  resourceType: ResourceType | null;
  resourceId: string | null;
};

type ConsumedHotelSetupHandoffRow = HotelSetupHandoffRow & {
  permissions: PermissionKey[];
  linkedResources: LinkedResource[];
  entitlements: HotelSetupHandoffEntitlementRow[];
};

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const MAX_CODE_INSERT_ATTEMPTS = 3;

export function createPgHotelSetupHandoffRepository(config: {
  connectionString: string;
  max?: number;
  pool?: HotelSetupHandoffQueryPool;
  now?: () => Date;
  ttlMs?: number;
  generateCode?: () => string;
}): HotelSetupHandoffRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Hotel setup handoff repository connectionString must not be empty");
  }
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 15 * 60 * 1_000) {
    throw new Error("Hotel setup handoff ttlMs must be between 1000 and 900000");
  }

  const ownsPool = config.pool === undefined;
  const pool = (config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    })) as HotelSetupHandoffQueryPool;
  const now = config.now ?? (() => new Date());
  const generateCode = config.generateCode ?? (() => randomBytes(32).toString("base64url"));

  return {
    async issue(input) {
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + ttlMs);

      for (let attempt = 0; attempt < MAX_CODE_INSERT_ATTEMPTS; attempt += 1) {
        const code = generateCode();
        if (!isOpaqueHotelSetupHandoffCode(code)) {
          throw new Error("Hotel setup handoff code generator must return 32 base64url bytes");
        }
        try {
          await pool.query(
            `INSERT INTO hotel_catalog.setup_handoffs (
               code_sha256,
               internal_user_id,
               provider_session_id,
               organization_id,
               membership_id,
               property_id,
               task_id,
               issued_plan_revision,
               destination_route_key,
               return_url,
               expires_at,
               created_at
             )
             VALUES (
               $1::bytea,
               $2::uuid,
               $3,
               $4::uuid,
               $5::uuid,
               $6::uuid,
               $7,
               $8,
               $9,
               $10,
               $11::timestamptz,
               $12::timestamptz
             )`,
            [
              sha256(code),
              input.binding.internalUserId,
              input.binding.providerSessionId,
              input.binding.organizationId,
              input.binding.membershipId,
              input.propertyId,
              input.taskId,
              input.issuedPlanRevision,
              input.destinationRouteKey,
              input.returnUrl,
              expiresAt.toISOString(),
              issuedAt.toISOString(),
            ],
          );
          return { code, expiresAt: expiresAt.toISOString() };
        } catch (error) {
          if (!isUniqueViolation(error) || attempt === MAX_CODE_INSERT_ATTEMPTS - 1) throw error;
        }
      }

      throw new Error("Hotel setup handoff code generation failed");
    },

    async findActive(code) {
      if (!isOpaqueHotelSetupHandoffCode(code)) return null;
      const result = await pool.query<HotelSetupHandoffRow>(
        `${selectHandoffColumns()}
         FROM hotel_catalog.setup_handoffs
         WHERE code_sha256 = $1::bytea
           AND consumed_at IS NULL
           AND expires_at > $2::timestamptz
         LIMIT 1`,
        [sha256(code), now().toISOString()],
      );
      return result.rows[0] ? toStoredHandoff(result.rows[0]) : null;
    },

    async consume({ id, code, binding }) {
      if (!isOpaqueHotelSetupHandoffCode(code)) return null;
      const consumedAt = now().toISOString();
      // This statement is the authorization linearization point: it wins the
      // single-use consume and snapshots current access from one SQL snapshot.
      const result = await pool.query<ConsumedHotelSetupHandoffRow>(
        `WITH consumed AS (
           UPDATE hotel_catalog.setup_handoffs handoff
           SET consumed_at = $7::timestamptz
           FROM identity.users actor,
                identity.organizations organization,
                identity.organization_memberships membership
           WHERE handoff.id = $1::uuid
             AND handoff.code_sha256 = $2::bytea
             AND handoff.internal_user_id = $3::uuid
             AND handoff.provider_session_id = $4
             AND handoff.organization_id = $5::uuid
             AND handoff.membership_id = $6::uuid
             AND handoff.consumed_at IS NULL
             AND handoff.expires_at > $7::timestamptz
             AND actor.id = handoff.internal_user_id
             AND actor.status = 'active'
             AND organization.id = handoff.organization_id
             AND organization.kind = 'hotel_group'
             AND organization.status = 'active'
             AND membership.id = handoff.membership_id
             AND membership.organization_id = handoff.organization_id
             AND membership.user_id = handoff.internal_user_id
             AND membership.status = 'active'
             AND EXISTS (
               SELECT 1
               FROM identity.role_permission_grants permission
               WHERE permission.organization_kind = organization.kind
                 AND permission.role_key = membership.role_key
                 AND permission.permission_key = 'hotel_catalog.setup.read'
             )
             AND EXISTS (
               SELECT 1
               FROM identity.organization_resource_links property_link
               WHERE property_link.organization_id = handoff.organization_id
                 AND property_link.product = 'hotel_catalog'
                 AND property_link.resource_type = 'property'
                 AND property_link.resource_id = handoff.property_id::text
                 AND property_link.relationship IN ('owner', 'operator')
                 AND property_link.status = 'active'
             )
           RETURNING
             handoff.id::text AS "id",
             handoff.internal_user_id::text AS "internalUserId",
             handoff.provider_session_id AS "providerSessionId",
             handoff.organization_id::text AS "organizationId",
             handoff.membership_id::text AS "membershipId",
             handoff.property_id::text AS "propertyId",
             handoff.task_id AS "taskId",
             handoff.issued_plan_revision AS "issuedPlanRevision",
             handoff.destination_route_key AS "destinationRouteKey",
             handoff.return_url AS "returnUrl",
             handoff.expires_at AS "expiresAt",
             organization.kind AS "organizationKind",
             membership.role_key AS "roleKey"
         )
         SELECT
           consumed."id",
           consumed."internalUserId",
           consumed."providerSessionId",
           consumed."organizationId",
           consumed."membershipId",
           consumed."propertyId",
           consumed."taskId",
           consumed."issuedPlanRevision",
           consumed."destinationRouteKey",
           consumed."returnUrl",
           consumed."expiresAt",
           COALESCE(
             (
               SELECT jsonb_agg(permission.permission_key ORDER BY permission.permission_key)
               FROM identity.role_permission_grants permission
               WHERE permission.organization_kind = consumed."organizationKind"
                 AND permission.role_key = consumed."roleKey"
             ),
             '[]'::jsonb
           ) AS "permissions",
           COALESCE(
             (
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'product', resource.product,
                   'resourceType', resource.resource_type,
                   'resourceId', resource.resource_id,
                   'relationship', resource.relationship,
                   'status', resource.status
                 )
                 ORDER BY
                   resource.product,
                   resource.resource_type,
                   resource.resource_id,
                   resource.relationship
               )
               FROM identity.organization_resource_links resource
               WHERE resource.organization_id = consumed."organizationId"::uuid
                 AND resource.status = 'active'
             ),
             '[]'::jsonb
           ) AS "linkedResources",
           COALESCE(
             (
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'product', entitlement.product,
                   'key', entitlement.entitlement_key,
                   'status',
                     CASE
                       WHEN entitlement.expires_at IS NOT NULL
                         AND entitlement.expires_at <= $7::timestamptz
                         THEN 'expired'
                       ELSE entitlement.status
                     END,
                   'resourceProduct', entitlement.resource_product,
                   'resourceType', entitlement.resource_type,
                   'resourceId', entitlement.resource_id
                 )
                 ORDER BY
                   entitlement.product,
                   entitlement.entitlement_key,
                   entitlement.resource_product NULLS FIRST,
                   entitlement.resource_type NULLS FIRST,
                   entitlement.resource_id NULLS FIRST
               )
               FROM identity.product_entitlements entitlement
               WHERE entitlement.organization_id = consumed."organizationId"::uuid
                 AND (
                   entitlement.starts_at IS NULL
                   OR entitlement.starts_at <= $7::timestamptz
                 )
                 AND (
                   entitlement.resource_product IS NULL
                   OR (
                     entitlement.status = 'suspended'
                     AND (
                       entitlement.expires_at IS NULL
                       OR entitlement.expires_at > $7::timestamptz
                     )
                   )
                   OR EXISTS (
                     SELECT 1
                     FROM identity.organization_resource_links entitlement_link
                     WHERE entitlement_link.organization_id =
                           consumed."organizationId"::uuid
                       AND entitlement_link.product = entitlement.resource_product
                       AND entitlement_link.resource_type = entitlement.resource_type
                       AND entitlement_link.resource_id = entitlement.resource_id
                       AND entitlement_link.status = 'active'
                   )
                 )
             ),
             '[]'::jsonb
           ) AS "entitlements"
         FROM consumed`,
        [
          id,
          sha256(code),
          binding.internalUserId,
          binding.providerSessionId,
          binding.organizationId,
          binding.membershipId,
          consumedAt,
        ],
      );
      return result.rows[0] ? toConsumedHandoff(result.rows[0]) : null;
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

function selectHandoffColumns(): string {
  return `SELECT
    id::text AS "id",
    internal_user_id::text AS "internalUserId",
    provider_session_id AS "providerSessionId",
    organization_id::text AS "organizationId",
    membership_id::text AS "membershipId",
    property_id::text AS "propertyId",
    task_id AS "taskId",
    issued_plan_revision AS "issuedPlanRevision",
    destination_route_key AS "destinationRouteKey",
    return_url AS "returnUrl",
    expires_at AS "expiresAt"`;
}

function toStoredHandoff(row: HotelSetupHandoffRow): StoredHotelSetupHandoff {
  return {
    ...row,
    expiresAt:
      row.expiresAt instanceof Date
        ? row.expiresAt.toISOString()
        : new Date(row.expiresAt).toISOString(),
  };
}

function toConsumedHandoff(row: ConsumedHotelSetupHandoffRow): ConsumedHotelSetupHandoff {
  return {
    ...toStoredHandoff(row),
    access: {
      permissions: row.permissions,
      linkedResources: row.linkedResources,
      entitlements: row.entitlements.map((entitlement): ProductEntitlement => {
        const key = canonicalEntitlementKey(entitlement.product, entitlement.key);
        if (entitlement.resourceProduct === null) {
          return {
            product: entitlement.product,
            key,
            status: entitlement.status,
          };
        }
        return {
          product: entitlement.product,
          key,
          status: entitlement.status,
          resource: {
            product: entitlement.resourceProduct,
            resourceType: entitlement.resourceType!,
            resourceId: entitlement.resourceId!,
          },
        };
      }),
    },
  };
}

function canonicalEntitlementKey(product: Product, key: string): string {
  if (product === "booking" && key === "account_access") return "booking-engine";
  if (product === "pms" && (key === "account_access" || key === "pms-core")) {
    return "property-management";
  }
  if (product === "marketplace" && key === "account_access") {
    return "marketplace-hotel-profile";
  }
  return key;
}

function sha256(code: string): Buffer {
  return createHash("sha256").update(code, "utf8").digest();
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
