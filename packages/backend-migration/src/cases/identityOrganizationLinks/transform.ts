import type pg from "pg";

export async function transformIdentityOrganizationLinks(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO identity.users (id, email, name, status, created_at, updated_at)
    SELECT
      users.id,
      users.email,
      users.name,
      CASE users.status
        WHEN 'verified' THEN 'active'
        WHEN 'pending' THEN 'pending'
        WHEN 'suspended' THEN 'suspended'
        WHEN 'rejected' THEN 'deleted'
        ELSE NULL
      END AS status,
      users.created_at,
      users.updated_at
    FROM migration_source_auth.users users
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO identity.external_identities
      (user_id, provider, provider_user_id, provider_email, provider_email_verified, raw_profile, created_at, updated_at)
    SELECT DISTINCT ON (users.workos_user_id)
      users.id,
      'workos',
      users.workos_user_id,
      users.email,
      users.email_verified,
      jsonb_build_object('source', 'auth.users', 'legacyUserType', users.type),
      users.created_at,
      users.updated_at
    FROM migration_source_auth.users users
    WHERE users.workos_user_id IS NOT NULL
    ORDER BY users.workos_user_id, users.id
    ON CONFLICT (provider, provider_user_id) WHERE provider_user_id IS NOT NULL DO UPDATE SET
      user_id = EXCLUDED.user_id,
      provider_email = EXCLUDED.provider_email,
      provider_email_verified = EXCLUDED.provider_email_verified,
      raw_profile = EXCLUDED.raw_profile,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO identity.organizations
      (id, kind, name, slug, status, workos_org_id, workos_external_id, created_at, updated_at)
    SELECT DISTINCT ON (links.organization_id)
      links.organization_id,
      links.organization_kind,
      links.organization_name,
      links.organization_slug,
      links.organization_status,
      links.workos_org_id,
      links.workos_external_id,
      min(links.created_at) OVER (PARTITION BY links.organization_id),
      max(links.updated_at) OVER (PARTITION BY links.organization_id)
    FROM migration_source_auth.identity_organization_links links
    ORDER BY links.organization_id, links.source_row_id
    ON CONFLICT (id) DO UPDATE SET
      kind = EXCLUDED.kind,
      name = EXCLUDED.name,
      slug = EXCLUDED.slug,
      status = EXCLUDED.status,
      workos_org_id = EXCLUDED.workos_org_id,
      workos_external_id = EXCLUDED.workos_external_id,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO identity.organization_memberships
      (organization_id, user_id, status, role_key, property_access_mode, access_origin, workos_membership_id, workos_role_slugs, created_at, updated_at)
    SELECT DISTINCT ON (links.organization_id, links.user_id)
      links.organization_id,
      links.user_id,
      links.membership_status,
      links.role_key,
      CASE
        WHEN links.organization_kind = 'hotel_group'
          AND links.role_key IN ('hotel_owner', 'owner', 'operator') THEN 'all'
        ELSE 'assigned'
      END,
      'agency',
      links.workos_membership_id,
      links.workos_role_slugs,
      min(links.created_at) OVER (PARTITION BY links.organization_id, links.user_id),
      max(links.updated_at) OVER (PARTITION BY links.organization_id, links.user_id)
    FROM migration_source_auth.identity_organization_links links
    ORDER BY links.organization_id, links.user_id, links.source_row_id
    ON CONFLICT (organization_id, user_id) DO UPDATE SET
      status = EXCLUDED.status,
      role_key = EXCLUDED.role_key,
      property_access_mode = EXCLUDED.property_access_mode,
      workos_membership_id = EXCLUDED.workos_membership_id,
      workos_role_slugs = EXCLUDED.workos_role_slugs,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO identity.organization_resource_links
      (organization_id, product, resource_type, resource_id, relationship, status, created_at, updated_at)
    SELECT DISTINCT ON (
      links.organization_id,
      links.product,
      links.resource_type,
      links.resource_id,
      links.relationship
    )
      links.organization_id,
      links.product,
      links.resource_type,
      links.resource_id,
      links.relationship,
      links.resource_status,
      links.created_at,
      links.updated_at
    FROM migration_source_auth.identity_organization_links links
    ORDER BY
      links.organization_id,
      links.product,
      links.resource_type,
      links.resource_id,
      links.relationship,
      links.source_row_id
    ON CONFLICT (organization_id, product, resource_type, resource_id, relationship) DO UPDATE SET
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO identity.product_entitlements
      (
        organization_id,
        product,
        entitlement_key,
        status,
        resource_product,
        resource_type,
        resource_id,
        starts_at,
        expires_at,
        metadata,
        created_at,
        updated_at
      )
    SELECT DISTINCT ON (
      entitlement.organization_id,
      entitlement.product,
      entitlement.entitlement_key,
      COALESCE(entitlement.resource_product, ''),
      COALESCE(entitlement.resource_type, ''),
      COALESCE(entitlement.resource_id, '')
    )
      entitlement.organization_id,
      entitlement.product,
      entitlement.entitlement_key,
      entitlement.status,
      entitlement.resource_product,
      entitlement.resource_type,
      entitlement.resource_id,
      entitlement.starts_at,
      entitlement.expires_at,
      entitlement.metadata,
      entitlement.created_at,
      entitlement.updated_at
    FROM migration_source_auth.identity_entitlement_inputs entitlement
    ORDER BY
      entitlement.organization_id,
      entitlement.product,
      entitlement.entitlement_key,
      COALESCE(entitlement.resource_product, ''),
      COALESCE(entitlement.resource_type, ''),
      COALESCE(entitlement.resource_id, ''),
      entitlement.source_row_id
    ON CONFLICT (
      organization_id,
      product,
      entitlement_key,
      COALESCE(resource_product, ''),
      COALESCE(resource_type, ''),
      COALESCE(resource_id, '')
    ) DO UPDATE SET
      status = EXCLUDED.status,
      starts_at = EXCLUDED.starts_at,
      expires_at = EXCLUDED.expires_at,
      metadata = EXCLUDED.metadata,
      updated_at = EXCLUDED.updated_at
  `);
}
