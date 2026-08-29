import type pg from "pg";

import type { ProductionIdentityPlan } from "./productionIdentityPlan.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export type CoreIdentityWritePlan = Pick<
  ProductionIdentityPlan,
  "users" | "organizations" | "memberships" | "resourceLinks" | "entitlements" | "blockers"
>;

export async function writeProductionIdentityCore(
  client: QueryClient,
  plan: CoreIdentityWritePlan,
): Promise<void> {
  if (plan.blockers.length > 0) throw new Error("Refusing to write a blocked identity plan");

  await write(
    client,
    plan.users,
    `INSERT INTO identity.users (id, email, name, status, created_at, updated_at)
     SELECT id, email, name, status, "createdAt", "updatedAt"
     FROM jsonb_to_recordset($1::jsonb)
       AS source(id uuid, email text, name text, status text,
                 "createdAt" timestamptz, "updatedAt" timestamptz)
     ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name,
           status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
     WHERE identity.users.updated_at < EXCLUDED.updated_at`,
  );
  await write(
    client,
    plan.organizations,
    `INSERT INTO identity.organizations (id, kind, name, slug, status, created_at, updated_at)
     SELECT id, kind, name, slug, status, "createdAt", "updatedAt"
     FROM jsonb_to_recordset($1::jsonb)
       AS source(id uuid, kind text, name text, slug text, status text,
                 "createdAt" timestamptz, "updatedAt" timestamptz)
     ON CONFLICT (id) DO UPDATE
       SET kind = EXCLUDED.kind, name = EXCLUDED.name, slug = EXCLUDED.slug,
           status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
     WHERE identity.organizations.updated_at < EXCLUDED.updated_at`,
  );
  await write(
    client,
    plan.memberships,
    `INSERT INTO identity.organization_memberships
       (organization_id, user_id, status, role_key, property_access_mode,
        access_origin, created_at, updated_at)
     SELECT "organizationId", "userId", status, "roleKey", "propertyAccessMode",
            "accessOrigin", "createdAt", "updatedAt"
     FROM jsonb_to_recordset($1::jsonb)
       AS source("organizationId" uuid, "userId" uuid, status text, "roleKey" text,
                 "propertyAccessMode" text, "accessOrigin" text,
                 "createdAt" timestamptz, "updatedAt" timestamptz)
     ON CONFLICT (organization_id, user_id) DO UPDATE
       SET status = EXCLUDED.status, role_key = EXCLUDED.role_key,
           property_access_mode = EXCLUDED.property_access_mode,
           updated_at = EXCLUDED.updated_at
     WHERE identity.organization_memberships.updated_at < EXCLUDED.updated_at`,
  );
  await write(
    client,
    plan.resourceLinks,
    `INSERT INTO identity.organization_resource_links
       (organization_id, product, resource_type, resource_id, relationship,
        status, created_at, updated_at)
     SELECT "organizationId", product, "resourceType", "resourceId", relationship,
            status, "createdAt", "updatedAt"
     FROM jsonb_to_recordset($1::jsonb)
       AS source("organizationId" uuid, product text, "resourceType" text,
                 "resourceId" text, relationship text, status text,
                 "createdAt" timestamptz, "updatedAt" timestamptz)
     ON CONFLICT (organization_id, product, resource_type, resource_id, relationship) DO UPDATE
       SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
     WHERE identity.organization_resource_links.updated_at < EXCLUDED.updated_at`,
  );
  await write(
    client,
    plan.entitlements,
    `INSERT INTO identity.product_entitlements
       (organization_id, product, entitlement_key, status, resource_product,
        resource_type, resource_id, starts_at, expires_at, metadata, created_at, updated_at)
     SELECT "organizationId", product, "entitlementKey", status, "resourceProduct",
            "resourceType", "resourceId", "startsAt", "expiresAt", metadata,
            "createdAt", "updatedAt"
     FROM jsonb_to_recordset($1::jsonb)
       AS source("organizationId" uuid, product text, "entitlementKey" text, status text,
                 "resourceProduct" text, "resourceType" text, "resourceId" text,
                 "startsAt" timestamptz, "expiresAt" timestamptz, metadata jsonb,
                 "createdAt" timestamptz, "updatedAt" timestamptz)
     ON CONFLICT (organization_id, product, entitlement_key,
                  COALESCE(resource_product, ''), COALESCE(resource_type, ''),
                  COALESCE(resource_id, '')) DO UPDATE
       SET status = EXCLUDED.status, starts_at = EXCLUDED.starts_at,
           expires_at = EXCLUDED.expires_at, metadata = EXCLUDED.metadata,
           updated_at = EXCLUDED.updated_at
     WHERE identity.product_entitlements.updated_at < EXCLUDED.updated_at`,
  );
}

async function write(client: QueryClient, rows: unknown[], sql: string): Promise<void> {
  if (rows.length === 0) return;
  await client.query(sql, [JSON.stringify(rows)]);
}
