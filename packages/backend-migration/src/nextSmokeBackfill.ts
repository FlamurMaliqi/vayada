import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";

export const NEXT_SMOKE_CONFIRM = "next-smoke-backfill:vay-874-vay-877";
export const NEXT_SMOKE_BOOKING_HOTEL_ID = "43303cea-963c-445a-9522-a05145fe0918";
export const NEXT_SMOKE_AFFILIATE_EMAIL = "flamur.maliqi2811@gmail.com";
export const NEXT_SMOKE_AFFILIATE_RESOURCE_ID = "affiliate-smoke-flamur-maliqi2811";
export const DEFAULT_NEXT_SMOKE_MODULE_IDS = ["affiliates"] as const;

export type NextSmokeBackfillMode = "dry-run" | "apply";

export type NextSmokeBackfillConfig = {
  mode: NextSmokeBackfillMode;
  targetConnectionString: string;
  bookingHotelId?: string;
  hotelOrganizationId?: string;
  marketplaceHotelProfileResourceId?: string;
  affiliateUserEmail?: string;
  affiliateOrganizationId?: string;
  affiliateResourceId?: string;
  affiliateWorkosOrgId?: string;
  affiliateWorkosMembershipId?: string;
  pmsConnectionString?: string;
  pmsHotelId?: string;
  moduleIds?: string[];
  max?: number;
};

export async function runNextSmokeBackfill(config: NextSmokeBackfillConfig) {
  const configBlockers = nextSmokeConfigBlockers(config);
  if (config.mode === "apply" && configBlockers.length > 0) {
    throw new Error(`Cannot apply next smoke backfill: ${configBlockers.join(", ")}.`);
  }

  const bookingHotelId = config.bookingHotelId ?? NEXT_SMOKE_BOOKING_HOTEL_ID;
  const affiliateEmail = normalizeEmail(config.affiliateUserEmail ?? NEXT_SMOKE_AFFILIATE_EMAIL);
  const affiliateResourceId =
    config.affiliateResourceId ?? affiliateResourceIdForEmail(affiliateEmail);
  const moduleIds = normalizeModuleIds(config.moduleIds ?? []);

  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.targetConnectionString),
    max: config.max,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hotelOrg = await loadHotelOrg(client, bookingHotelId, config.hotelOrganizationId);
    const marketplaceProfile = await loadMarketplaceProfile(client, {
      organizationId: hotelOrg.organizationId,
      bookingHotelId,
      explicitResourceId: config.marketplaceHotelProfileResourceId,
    });
    const affiliateUser = await loadAffiliateUser(client, affiliateEmail);
    const affiliateOrg = await ensureAffiliateOrg(client, {
      organizationId: config.affiliateOrganizationId,
      email: affiliateEmail,
      userId: affiliateUser.userId,
      workosOrgId: config.affiliateWorkosOrgId,
      workosMembershipId: config.affiliateWorkosMembershipId,
      allowIdentityWrites: config.mode !== "apply",
    });
    const blockers = nextSmokeApplyBlockers({
      mode: config.mode,
      pmsConnectionString: config.pmsConnectionString,
      hotelOrg,
      affiliateOrg,
    });
    if (config.mode === "apply" && blockers.length > 0) {
      throw new Error(`Cannot apply next smoke backfill: ${blockers.join(", ")}.`);
    }

    await upsertEntitlement(client, hotelOrg.organizationId, {
      product: "booking",
      key: "booking-engine",
      resourceProduct: "booking",
      resourceType: "booking_hotel",
      resourceId: bookingHotelId,
      source: "VAY-874",
    });
    await upsertResourceLink(client, hotelOrg.organizationId, {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: marketplaceProfile.resourceId,
      relationship: "owner",
    });
    await upsertResourceLink(client, hotelOrg.organizationId, {
      product: "marketplace",
      resourceType: "hotel_profile",
      resourceId: marketplaceProfile.resourceId,
      relationship: "owner",
    });
    await upsertEntitlement(client, hotelOrg.organizationId, {
      product: "marketplace",
      key: "marketplace-hotel-profile",
      resourceProduct: "marketplace",
      resourceType: "hotel_profile",
      resourceId: marketplaceProfile.resourceId,
      source: "VAY-877",
    });
    await upsertResourceLink(client, affiliateOrg.organizationId, {
      product: "affiliate",
      resourceType: "affiliate",
      resourceId: affiliateResourceId,
      relationship: "owner",
    });
    await upsertEntitlement(client, affiliateOrg.organizationId, {
      product: "affiliate",
      key: "affiliate-payouts",
      resourceProduct: "affiliate",
      resourceType: "affiliate",
      resourceId: affiliateResourceId,
      source: "VAY-877",
    });

    const pmsModules = config.pmsConnectionString
      ? await upsertPmsModules({
          mode: config.mode,
          connectionString: config.pmsConnectionString,
          pmsHotelId: config.pmsHotelId ?? bookingHotelId,
          moduleIds,
          max: config.max,
        })
      : undefined;

    await client.query(config.mode === "apply" ? "COMMIT" : "ROLLBACK");

    return {
      kind: "next_smoke_backfill",
      mode: config.mode,
      bookingHotelId,
      hotelOrganization: hotelOrg,
      bookingEntitlement: `booking:booking-engine:booking_hotel:${bookingHotelId}`,
      property: {
        resourceId: marketplaceProfile.resourceId,
        resourceLink: `hotel_catalog:property:${marketplaceProfile.resourceId}`,
      },
      marketplace: {
        hotelProfileResourceId: marketplaceProfile.resourceId,
        sourceHotelProfileId: marketplaceProfile.sourceHotelProfileId,
        resourceLink: `marketplace:hotel_profile:${marketplaceProfile.resourceId}`,
        entitlement: `marketplace:marketplace-hotel-profile:${marketplaceProfile.resourceId}`,
      },
      affiliate: {
        userId: affiliateUser.userId,
        email: affiliateEmail,
        organization: affiliateOrg,
        resourceId: affiliateResourceId,
        resourceLink: `affiliate:affiliate:${affiliateResourceId}`,
        entitlement: `affiliate:affiliate-payouts:${affiliateResourceId}`,
      },
      pmsModules,
      blockers,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export function nextSmokeConfigBlockers(
  config: Pick<
    NextSmokeBackfillConfig,
    "mode" | "affiliateOrganizationId" | "affiliateWorkosOrgId" | "affiliateWorkosMembershipId"
  >,
): string[] {
  return [
    ...(config.mode === "apply" && !config.affiliateOrganizationId
      ? ["affiliate_organization_id_required_for_apply"]
      : []),
    ...(config.mode === "apply" && config.affiliateWorkosOrgId
      ? ["affiliate_workos_org_id_flag_is_dry_run_only"]
      : []),
    ...(config.mode === "apply" && config.affiliateWorkosMembershipId
      ? ["affiliate_workos_membership_id_flag_is_dry_run_only"]
      : []),
  ];
}

export function nextSmokeApplyBlockers(input: {
  mode: NextSmokeBackfillMode;
  pmsConnectionString?: string;
  hotelOrg: { workosOrgId: string | null; activeMemberships: unknown[] };
  affiliateOrg: { workosOrgId: string | null; workosMembershipId: string | null };
}): string[] {
  return [
    ...(input.mode === "apply" && !input.pmsConnectionString
      ? ["pms_database_url_required_for_feature_hub_modules"]
      : []),
    ...(!input.hotelOrg.workosOrgId ? ["hotel_group_missing_workos_org_id"] : []),
    ...(input.hotelOrg.activeMemberships.length === 0
      ? ["hotel_group_missing_active_membership"]
      : []),
    ...(!input.affiliateOrg.workosOrgId ? ["affiliate_partner_missing_workos_org_id"] : []),
    ...(!input.affiliateOrg.workosMembershipId
      ? ["affiliate_partner_missing_workos_membership_id"]
      : []),
  ];
}

export function affiliateResourceIdForEmail(email: string): string {
  return `affiliate-smoke-${normalizeEmail(email)
    .split("@")[0]
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

export function normalizeModuleIds(input: string[]): string[] {
  const moduleIds = input.map((value) => value.trim()).filter(Boolean);
  if (moduleIds.length === 0) return [...DEFAULT_NEXT_SMOKE_MODULE_IDS];
  for (const moduleId of moduleIds) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(moduleId)) {
      throw new Error(`Invalid module id "${moduleId}".`);
    }
  }
  return Array.from(new Set(moduleIds));
}

async function loadHotelOrg(client: pg.PoolClient, bookingHotelId: string, organizationId = "") {
  const { rows } = await client.query<{
    organization_id: string;
    name: string;
    workos_org_id: string | null;
    workos_external_id: string | null;
    active_memberships: unknown[];
  }>(
    `SELECT
       organization.id::text AS organization_id,
       organization.name,
       organization.workos_org_id,
       organization.workos_external_id,
       COALESCE(
         jsonb_agg(jsonb_build_object(
           'userId', users.id::text,
           'email', users.email,
           'roleKey', membership.role_key,
           'workosMembershipId', membership.workos_membership_id
         ) ORDER BY users.email) FILTER (WHERE users.id IS NOT NULL),
         '[]'::jsonb
       ) AS active_memberships
     FROM identity.organization_resource_links link
     JOIN identity.organizations organization ON organization.id = link.organization_id
     LEFT JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id AND membership.status = 'active'
     LEFT JOIN identity.users users ON users.id = membership.user_id AND users.status = 'active'
     WHERE link.product = 'booking'
       AND link.resource_type = 'booking_hotel'
       AND link.resource_id = $1
       AND link.relationship IN ('owner', 'operator')
       AND link.status = 'active'
       AND organization.kind = 'hotel_group'
       AND organization.status = 'active'
       AND ($2::uuid IS NULL OR organization.id = $2::uuid)
     GROUP BY organization.id
     ORDER BY organization.name, organization.id
     LIMIT 2`,
    [bookingHotelId, organizationId || null],
  );
  if (rows.length === 0) throw new Error(`No hotel_group owns ${bookingHotelId}.`);
  if (!organizationId && rows.length > 1) {
    throw new Error(
      `Multiple hotel_group orgs own ${bookingHotelId}; pass --hotel-organization-id.`,
    );
  }
  const row = rows[0]!;
  return {
    organizationId: row.organization_id,
    kind: "hotel_group",
    name: row.name,
    workosOrgId: row.workos_org_id,
    workosExternalId: row.workos_external_id,
    activeMemberships: row.active_memberships,
  };
}

async function loadMarketplaceProfile(
  client: pg.PoolClient,
  input: { organizationId: string; bookingHotelId: string; explicitResourceId?: string },
) {
  if (input.explicitResourceId) {
    const { rows } = await client.query<{
      resource_id: string;
      source_hotel_profile_id: string | null;
    }>(
      `WITH booking_property AS (
         SELECT property_id
         FROM hotel_catalog.property_source_links
         WHERE source_system = 'booking'
           AND source_table = 'booking_hotels'
           AND source_id = $3
           AND status = 'active'
         LIMIT 1
       )
       SELECT profile.property_id::text AS resource_id, profile.source_hotel_profile_id
       FROM marketplace.marketplace_hotel_profiles profile
       WHERE profile.organization_id = $1::uuid
         AND profile.property_id::text = $2
         AND (profile.property_id IN (SELECT property_id FROM booking_property)
              OR profile.property_id::text = $3)
       LIMIT 1`,
      [input.organizationId, input.explicitResourceId, input.bookingHotelId],
    );
    if (!rows[0]) {
      throw new Error(
        "Explicit marketplace hotel profile resource does not match the selected hotel organization/property.",
      );
    }
    return {
      resourceId: rows[0].resource_id,
      sourceHotelProfileId: rows[0].source_hotel_profile_id,
    };
  }
  const { rows } = await client.query<{
    resource_id: string;
    source_hotel_profile_id: string | null;
  }>(
    `WITH booking_property AS (
       SELECT property_id
       FROM hotel_catalog.property_source_links
       WHERE source_system = 'booking'
         AND source_table = 'booking_hotels'
         AND source_id = $2
         AND status = 'active'
       LIMIT 1
     )
     SELECT profile.property_id::text AS resource_id, profile.source_hotel_profile_id
     FROM marketplace.marketplace_hotel_profiles profile
     WHERE profile.organization_id = $1::uuid
       AND (profile.property_id IN (SELECT property_id FROM booking_property)
            OR profile.property_id::text = $2)
     ORDER BY profile.updated_at DESC
     LIMIT 1`,
    [input.organizationId, input.bookingHotelId],
  );
  if (!rows[0]) {
    throw new Error(
      "No marketplace hotel profile found; pass --marketplace-hotel-profile-resource-id.",
    );
  }
  return { resourceId: rows[0].resource_id, sourceHotelProfileId: rows[0].source_hotel_profile_id };
}

async function loadAffiliateUser(client: pg.PoolClient, email: string) {
  const { rows } = await client.query<{ id: string; email: string }>(
    `SELECT id::text, email
     FROM identity.users
     WHERE lower(email) = $1 AND status = 'active'
     ORDER BY created_at
     LIMIT 2`,
    [email],
  );
  if (rows.length !== 1) throw new Error(`Expected exactly one active user for ${email}.`);
  return { userId: rows[0]!.id, email: rows[0]!.email };
}

async function ensureAffiliateOrg(
  client: pg.PoolClient,
  input: {
    organizationId?: string;
    email: string;
    userId: string;
    workosOrgId?: string;
    workosMembershipId?: string;
    allowIdentityWrites: boolean;
  },
) {
  const existing = await findAffiliateOrg(client, input.userId, input.organizationId);
  if (!existing && !input.allowIdentityWrites) {
    throw new Error(
      "Affiliate organization must already exist before apply; run a prepare step and WorkOS backfill first.",
    );
  }
  if (existing && !input.allowIdentityWrites) {
    if (!existing.membershipId || existing.membershipStatus !== "active") {
      throw new Error(
        "Affiliate smoke user must already have an active affiliate organization membership before apply.",
      );
    }
    return {
      organizationId: existing.organization_id,
      kind: "affiliate_partner",
      name: existing.name,
      workosOrgId: existing.workos_org_id,
      workosExternalId: existing.workos_external_id,
      membershipId: existing.membershipId,
      workosMembershipId: existing.workosMembershipId,
    };
  }

  let org =
    existing ??
    (
      await client.query<{
        organization_id: string;
        name: string;
        workos_org_id: string | null;
        workos_external_id: string | null;
      }>(
        `INSERT INTO identity.organizations
           (kind, name, slug, status, workos_org_id)
         VALUES ('affiliate_partner', $1, $2, 'active', $3)
         RETURNING id::text AS organization_id, name, workos_org_id, workos_external_id`,
        [
          `Affiliate Smoke ${input.email}`,
          affiliateResourceIdForEmail(input.email),
          input.workosOrgId ?? null,
        ],
      )
    ).rows[0]!;
  if (input.workosOrgId && (org.workos_org_id !== input.workosOrgId || !org.workos_external_id)) {
    const updated = await client.query<typeof org>(
      `UPDATE identity.organizations
       SET workos_org_id = $2,
           workos_external_id = COALESCE(workos_external_id, id::text),
           updated_at = now()
       WHERE id = $1::uuid
         AND (workos_org_id IS NULL OR workos_org_id = $2)
       RETURNING id::text AS organization_id, name, workos_org_id, workos_external_id`,
      [org.organization_id, input.workosOrgId],
    );
    if (!updated.rows[0]) throw new Error("Affiliate organization has a different WorkOS org ID.");
    org = updated.rows[0];
  }
  const membership = await client.query<{ id: string; workos_membership_id: string | null }>(
    `INSERT INTO identity.organization_memberships
       (organization_id, user_id, status, role_key, property_access_mode, access_origin, workos_membership_id, workos_role_slugs)
     VALUES ($1::uuid, $2::uuid, 'active', 'affiliate_owner', 'assigned', 'agency', $3, ARRAY['affiliate_owner']::text[])
     ON CONFLICT (organization_id, user_id) DO UPDATE SET
       status = 'active',
       role_key = 'affiliate_owner',
       property_access_mode = 'assigned',
       workos_membership_id = COALESCE(identity.organization_memberships.workos_membership_id, EXCLUDED.workos_membership_id),
       workos_role_slugs = ARRAY['affiliate_owner']::text[],
       updated_at = now()
     RETURNING id::text, workos_membership_id`,
    [org.organization_id, input.userId, input.workosMembershipId ?? null],
  );
  const membershipRow = membership.rows[0]!;
  if (input.workosMembershipId && membershipRow.workos_membership_id !== input.workosMembershipId) {
    throw new Error("Affiliate membership has a different WorkOS membership ID.");
  }
  return {
    organizationId: org.organization_id,
    kind: "affiliate_partner",
    name: org.name,
    workosOrgId: org.workos_org_id,
    workosExternalId: org.workos_external_id,
    membershipId: membershipRow.id,
    workosMembershipId: membershipRow.workos_membership_id,
  };
}

async function findAffiliateOrg(client: pg.PoolClient, userId: string, organizationId = "") {
  const { rows } = await client.query<{
    organization_id: string;
    name: string;
    workos_org_id: string | null;
    workos_external_id: string | null;
    membership_id: string | null;
    membership_status: string | null;
    workos_membership_id: string | null;
  }>(
    `SELECT organization.id::text AS organization_id,
            organization.name,
            organization.workos_org_id,
            organization.workos_external_id,
            membership.id::text AS membership_id,
            membership.status AS membership_status,
            membership.workos_membership_id
     FROM identity.organizations organization
     LEFT JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id AND membership.user_id = $1::uuid
     WHERE organization.kind = 'affiliate_partner'
       AND organization.status = 'active'
       AND (($2::uuid IS NOT NULL AND organization.id = $2::uuid)
            OR ($2::uuid IS NULL AND membership.id IS NOT NULL))
     ORDER BY membership.status = 'active' DESC, organization.created_at
     LIMIT 2`,
    [userId, organizationId || null],
  );
  if (!organizationId && rows.length > 1) {
    throw new Error(
      "Smoke user has multiple affiliate_partner orgs; pass --affiliate-organization-id.",
    );
  }
  const row = rows[0];
  if (!row) return null;
  return {
    organization_id: row.organization_id,
    name: row.name,
    workos_org_id: row.workos_org_id,
    workos_external_id: row.workos_external_id,
    membershipId: row.membership_id,
    membershipStatus: row.membership_status,
    workosMembershipId: row.workos_membership_id,
  };
}

async function upsertResourceLink(
  client: pg.PoolClient,
  organizationId: string,
  input: { product: string; resourceType: string; resourceId: string; relationship: string },
) {
  await client.query(
    `INSERT INTO identity.organization_resource_links
       (organization_id, product, resource_type, resource_id, relationship, status)
     VALUES ($1::uuid, $2, $3, $4, $5, 'active')
     ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
     DO UPDATE SET status = 'active', updated_at = now()`,
    [organizationId, input.product, input.resourceType, input.resourceId, input.relationship],
  );
}

async function upsertEntitlement(
  client: pg.PoolClient,
  organizationId: string,
  input: {
    product: string;
    key: string;
    resourceProduct: string;
    resourceType: string;
    resourceId: string;
    source: string;
  },
) {
  await client.query(
    `INSERT INTO identity.product_entitlements
       (organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id, starts_at, expires_at, metadata)
     VALUES ($1::uuid, $2, $3, 'active', $4, $5, $6, now(), NULL, $7::jsonb)
     ON CONFLICT (
       organization_id, product, entitlement_key,
       COALESCE(resource_product, ''), COALESCE(resource_type, ''), COALESCE(resource_id, '')
     ) DO UPDATE SET
       status = 'active',
       starts_at = COALESCE(identity.product_entitlements.starts_at, EXCLUDED.starts_at),
       expires_at = NULL,
       metadata = identity.product_entitlements.metadata || EXCLUDED.metadata,
       updated_at = now()`,
    [
      organizationId,
      input.product,
      input.key,
      input.resourceProduct,
      input.resourceType,
      input.resourceId,
      JSON.stringify({ source: input.source, smoke: "next-stack" }),
    ],
  );
}

async function upsertPmsModules(input: {
  mode: NextSmokeBackfillMode;
  connectionString: string;
  pmsHotelId: string;
  moduleIds: string[];
  max?: number;
}) {
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(input.connectionString),
    max: input.max,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const moduleId of input.moduleIds) {
      await client.query(
        `INSERT INTO property_module_activations
           (hotel_id, module_id, is_active, activated_at, deactivated_at, updated_at)
         VALUES ($1::uuid, $2, true, now(), NULL, now())
         ON CONFLICT (hotel_id, module_id) DO UPDATE SET
           is_active = true,
           activated_at = COALESCE(property_module_activations.activated_at, now()),
           deactivated_at = NULL,
           updated_at = now()`,
        [input.pmsHotelId, moduleId],
      );
    }
    await client.query(input.mode === "apply" ? "COMMIT" : "ROLLBACK");
    return { pmsHotelId: input.pmsHotelId, moduleIds: input.moduleIds };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function normalizeEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Affiliate smoke email is required.");
  return normalized;
}
