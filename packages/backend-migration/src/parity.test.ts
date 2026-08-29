import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runParityChecks } from "./parity.js";
import { rebuild } from "./rebuild.js";
import { DEFAULT_REBUILD_SCHEMAS } from "./targetSchemas.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const TEST_DATABASE_NAME = TEST_DATABASE_URL
  ? decodeURIComponent(new URL(TEST_DATABASE_URL).pathname.replace(/^\//, ""))
  : "";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures");
const MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

describe("runParityChecks fixture config validation", () => {
  it("reports invalid shared expected-target config before connecting to the database", async () => {
    const fixturesDir = join(tmpdir(), `vayada-invalid-fixture-${Date.now()}`);
    const fixtureDir = join(fixturesDir, "cases", "invalid-config");
    await mkdir(fixtureDir, { recursive: true });

    try {
      await writeFile(
        join(fixtureDir, "expected-target.json"),
        JSON.stringify({
          counts: {
            "identity.users": "one",
          },
          idStability: {
            "identity.users": [1],
          },
          uniquenessChecks: ["external_identities", 2],
          identityChecks: {
            memberships: {},
          },
          catalogPublicProfileChecks: {
            customDomainProperties: ["bad"],
          },
          bookingCheckoutChecks: {
            flows: [
              {
                propertyId: "d3000000-0000-0000-0000-000000000682",
                organizationId: "d2000000-0000-0000-0000-000000000682",
                bookingHotelResourceId: "booking_hotel_checkout_alpenrose",
                quoteSessionId: "d4000000-0000-0000-0000-000000000682",
                checkoutContextId: "d5000000-0000-0000-0000-000000000682",
                guestBookingId: "d6000000-0000-0000-0000-000000000682",
                paymentId: "e2000000-0000-0000-0000-000000000682",
                publicQuoteReference: "Q-CHK-682",
                publicBookingReference: "B-CHK-682",
                lifecycleStatus: "confirmed",
                paymentStatus: "paid",
                paymentAmount: "420.00",
                currency: "EUR",
                guestCount: "two",
                addonSelectionCount: 1,
                promoApplicationCount: 1,
                statusEventCount: 2,
              },
            ],
            forbiddenSummaryKeys: [1],
          },
          financeChecks: {
            forbiddenVisibilityKeys: [1],
          },
          pmsOperationsChecks: {
            properties: {},
            forbiddenOperationalSummaryKeys: [1],
          },
          marketplaceChecks: {
            slices: {},
            forbiddenPublicReadModelValues: [1],
          },
          distributionBookabilityChecks: {
            properties: {},
            forbiddenPublicOutputValues: [1],
          },
          platformMediaChecks: {
            legacyUrlInventory: [],
            requiredPurposes: [1],
            requiredPublicVariants: [1],
            forbiddenPublicValues: [1],
          },
          mediaUrlMigrationChecks: {
            propertyPublicProfiles: [
              {
                propertyId: 1,
                mediaObjectIds: "invalid",
                urls: [1],
                forbiddenUrls: null,
              },
            ],
          },
        }),
      );

      const report = await runParityChecks({
        connectionString: "postgresql://vayada_test:vayada_test@127.0.0.1:1/not_used",
        fixtureCase: "invalid-config",
        fixturesDir,
        environment: "local",
      });

      expect(report.status).toBe("failed");
      expect(report.summary.failures).toBe(22);
      expect(report.findings).toEqual([
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.counts.identity.users",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.idStability.identity.users",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.uniquenessChecks",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.identityChecks.memberships",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.catalogPublicProfileChecks.customDomainProperties[0]",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.bookingCheckoutChecks.flows[0].guestCount",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.bookingCheckoutChecks.forbiddenSummaryKeys",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.financeChecks.forbiddenVisibilityKeys",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.pmsOperationsChecks.properties",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.pmsOperationsChecks.forbiddenOperationalSummaryKeys",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.marketplaceChecks.slices",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.marketplaceChecks.forbiddenPublicReadModelValues",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.distributionBookabilityChecks.properties",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject:
            "expected-target.json.distributionBookabilityChecks.forbiddenPublicOutputValues",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.platformMediaChecks.legacyUrlInventory",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.platformMediaChecks.requiredPurposes",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.platformMediaChecks.requiredPublicVariants",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject: "expected-target.json.platformMediaChecks.forbiddenPublicValues",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject:
            "expected-target.json.mediaUrlMigrationChecks.propertyPublicProfiles[0].propertyId",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject:
            "expected-target.json.mediaUrlMigrationChecks.propertyPublicProfiles[0].mediaObjectIds",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject:
            "expected-target.json.mediaUrlMigrationChecks.propertyPublicProfiles[0].urls",
        }),
        expect.objectContaining({
          code: "INVALID_FIXTURE_CONFIG",
          targetObject:
            "expected-target.json.mediaUrlMigrationChecks.propertyPublicProfiles[0].forbiddenUrls",
        }),
      ]);
    } finally {
      await rm(fixturesDir, { recursive: true, force: true });
    }
  });
});

async function dropTargetSchemas(): Promise<void> {
  assertSafeTestDatabase(TEST_DATABASE_URL!);

  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    for (const schema of DEFAULT_REBUILD_SCHEMAS) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await client.query(`DROP SCHEMA IF EXISTS migration_source_auth CASCADE`);
  } finally {
    await client.end();
  }
}

describe.skipIf(!TEST_DATABASE_URL)("runParityChecks (integration)", () => {
  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    await rebuild({
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: MIGRATIONS_DIR,
      environment: "local",
      schemas: [...DEFAULT_REBUILD_SCHEMAS],
      confirmedDatabaseName: TEST_DATABASE_NAME,
      fixtureCase: "identity-organization-links",
      fixturesDir: FIXTURES_DIR,
    });
  });

  afterEach(async () => {
    await dropTargetSchemas();
  });

  it("passes all checks for the identity-organization-links fixture", async () => {
    const report = await runParityChecks({
      connectionString: TEST_DATABASE_URL!,
      fixtureCase: "identity-organization-links",
      fixturesDir: FIXTURES_DIR,
      environment: "local",
    });

    expect(report.status).toBe("passed");
    expect(report.summary.failures).toBe(0);
    expect(report.findings.filter((f) => f.severity === "fail")).toHaveLength(0);
  });

  it("reports SOURCE_EXTERNAL_IDENTITY_DUPLICATE when source WorkOS IDs are duplicated", async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO migration_source_auth.users
          (id, email, name, type, status, email_verified, workos_user_id, created_at, updated_at)
        VALUES
          (
            'ffffffff-0000-0000-0000-000000000099',
            'dup@example.com',
            'Duplicate User',
            'hotel',
            'verified',
            TRUE,
            'user_workos_hotel_owner',
            now(),
            now()
          )
      `);
    } finally {
      await client.end();
    }

    const report = await runParityChecks({
      connectionString: TEST_DATABASE_URL!,
      fixtureCase: "identity-organization-links",
      fixturesDir: FIXTURES_DIR,
      environment: "local",
    });

    expect(report.status).toBe("failed");
    const violations = report.findings.filter(
      (f) => f.code === "SOURCE_EXTERNAL_IDENTITY_DUPLICATE",
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].targetObject).toBe("migration_source_auth.users");
  });

  it("reports ID_STABILITY_VIOLATION when a source user ID is not preserved", async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        `DELETE FROM identity.external_identities
         WHERE user_id = 'a1b2c3d4-0000-0000-0000-000000000001'`,
      );
      await client.query(
        `DELETE FROM identity.organization_memberships
         WHERE user_id = 'a1b2c3d4-0000-0000-0000-000000000001'`,
      );
      await client.query(
        `DELETE FROM identity.users WHERE id = 'a1b2c3d4-0000-0000-0000-000000000001'`,
      );
    } finally {
      await client.end();
    }

    const report = await runParityChecks({
      connectionString: TEST_DATABASE_URL!,
      fixtureCase: "identity-organization-links",
      fixturesDir: FIXTURES_DIR,
      environment: "local",
    });

    expect(report.status).toBe("failed");
    const violations = report.findings.filter((f) => f.code === "ID_STABILITY_VIOLATION");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("reports SOURCE_RESOURCE_LINK_DUPLICATE when source ownership rows are duplicated", async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO migration_source_auth.identity_organization_links
          (
            source_row_id,
            user_id,
            organization_id,
            organization_kind,
            organization_name,
            organization_slug,
            organization_status,
            workos_org_id,
            workos_external_id,
            membership_status,
            role_key,
            workos_membership_id,
            workos_role_slugs,
            product,
            resource_type,
            resource_id,
            relationship,
            resource_status,
            created_at,
            updated_at
          )
        SELECT
          'booking-hotel-owner-duplicate',
          user_id,
          organization_id,
          organization_kind,
          organization_name,
          organization_slug,
          organization_status,
          workos_org_id,
          workos_external_id,
          membership_status,
          role_key,
          workos_membership_id,
          workos_role_slugs,
          product,
          resource_type,
          resource_id,
          relationship,
          resource_status,
          created_at,
          updated_at
        FROM migration_source_auth.identity_organization_links
        WHERE source_row_id = 'booking-hotel-owner'
      `);
    } finally {
      await client.end();
    }

    const report = await runParityChecks({
      connectionString: TEST_DATABASE_URL!,
      fixtureCase: "identity-organization-links",
      fixturesDir: FIXTURES_DIR,
      environment: "local",
    });

    expect(report.status).toBe("failed");
    const violations = report.findings.filter((f) => f.code === "SOURCE_RESOURCE_LINK_DUPLICATE");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("reports SOURCE_RESOURCE_LINK_AMBIGUOUS when one resource maps to two organizations", async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO migration_source_auth.identity_organization_links
          (
            source_row_id,
            user_id,
            organization_id,
            organization_kind,
            organization_name,
            organization_slug,
            organization_status,
            workos_org_id,
            workos_external_id,
            membership_status,
            role_key,
            workos_membership_id,
            workos_role_slugs,
            product,
            resource_type,
            resource_id,
            relationship,
            resource_status,
            created_at,
            updated_at
          )
        SELECT
          'booking-hotel-owner-ambiguous',
          user_id,
          'b2c3d4e5-0000-0000-0000-000000000099',
          organization_kind,
          'Ambiguous Hotel Group',
          'ambiguous-hotel-group',
          organization_status,
          'org_workos_ambiguous_hotel_group',
          'b2c3d4e5-0000-0000-0000-000000000099',
          membership_status,
          role_key,
          'om_ambiguous_hotel_owner',
          workos_role_slugs,
          product,
          resource_type,
          resource_id,
          relationship,
          resource_status,
          created_at,
          updated_at
        FROM migration_source_auth.identity_organization_links
        WHERE source_row_id = 'booking-hotel-owner'
      `);
    } finally {
      await client.end();
    }

    const report = await runParityChecks({
      connectionString: TEST_DATABASE_URL!,
      fixtureCase: "identity-organization-links",
      fixturesDir: FIXTURES_DIR,
      environment: "local",
    });

    expect(report.status).toBe("failed");
    const violations = report.findings.filter((f) => f.code === "SOURCE_RESOURCE_LINK_AMBIGUOUS");
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("rebuild with fixture loading (integration)", () => {
  afterEach(async () => {
    await dropTargetSchemas();
  });

  it("checks the confirmed database name before dropping schemas", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA rebuild_confirmation_guard`);

      await expect(
        rebuild({
          connectionString: TEST_DATABASE_URL!,
          migrationsDir: MIGRATIONS_DIR,
          environment: "local",
          schemas: ["rebuild_confirmation_guard"],
          confirmedDatabaseName: `${TEST_DATABASE_NAME}_wrong`,
        }),
      ).rejects.toThrow(/does not match confirmed database/);

      await expect(
        rebuild({
          connectionString: TEST_DATABASE_URL!,
          migrationsDir: MIGRATIONS_DIR,
          environment: "local",
          schemas: ["rebuild_confirmation_guard", "invalid-name"],
          confirmedDatabaseName: TEST_DATABASE_NAME,
        }),
      ).rejects.toThrow(/Unsafe schema identifier/);

      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'rebuild_confirmation_guard'
         ) AS exists`,
      );
      expect(rows[0]?.exists).toBe(true);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS rebuild_confirmation_guard CASCADE`);
      await client.end();
    }
  });

  it("applies target migrations and loads the identity fixture without error", async () => {
    const result = await rebuild({
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: MIGRATIONS_DIR,
      environment: "local",
      schemas: [...DEFAULT_REBUILD_SCHEMAS],
      confirmedDatabaseName: TEST_DATABASE_NAME,
      fixtureCase: "identity-organization-links",
      fixturesDir: FIXTURES_DIR,
    });

    expect(result.applied).toEqual(expect.arrayContaining(["0001", "0002", "0003"]));
    expect(result.failed).toBeNull();

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT count(*)::int AS count FROM identity.users`);
      expect(rows[0].count).toBe(1);

      const memberships = await client.query(
        `SELECT count(*)::int AS count
         FROM identity.organization_memberships
         WHERE organization_id = 'b2c3d4e5-0000-0000-0000-000000000001'
           AND user_id = 'a1b2c3d4-0000-0000-0000-000000000001'
           AND role_key = 'hotel_owner'
           AND status = 'active'`,
      );
      expect(memberships.rows[0].count).toBe(1);

      const resourceLinks = await client.query(
        `SELECT product, resource_type, resource_id, relationship
         FROM identity.organization_resource_links
         ORDER BY product, resource_type`,
      );
      expect(resourceLinks.rows).toEqual([
        {
          product: "booking",
          resource_type: "booking_hotel",
          resource_id: "booking_hotel_alpenrose",
          relationship: "owner",
        },
        {
          product: "hotel_catalog",
          resource_type: "property",
          resource_id: "c2c3d4e5-0000-0000-0000-000000000001",
          relationship: "owner",
        },
        {
          product: "pms",
          resource_type: "pms_hotel",
          resource_id: "pms_hotel_alpenrose",
          relationship: "operator",
        },
      ]);

      const perms = await client.query(
        `SELECT
           count(*)::int AS count,
           bool_or(key = 'hotel_catalog.products.manage') AS has_products_manage
         FROM identity.permission_catalog`,
      );
      expect(perms.rows[0].count).toBe(29);
      expect(perms.rows[0].has_products_manage).toBe(true);

      const entitlements = await client.query(
        `SELECT count(*)::int AS count FROM identity.product_entitlements`,
      );
      expect(entitlements.rows[0].count).toBe(2);
    } finally {
      await client.end();
    }
  });

  it("backfills canonical property links after product fixture transforms", async () => {
    const result = await rebuild({
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: MIGRATIONS_DIR,
      environment: "local",
      schemas: [...DEFAULT_REBUILD_SCHEMAS],
      confirmedDatabaseName: TEST_DATABASE_NAME,
      fixtureCase: "booking-checkout",
      fixturesDir: FIXTURES_DIR,
    });

    expect(result.failed).toBeNull();

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const propertyLinks = await client.query(
        `SELECT organization_id::text, product, resource_type, resource_id, relationship, status
         FROM identity.organization_resource_links
         WHERE product = 'hotel_catalog'
         ORDER BY organization_id, resource_id`,
      );

      expect(propertyLinks.rows).toEqual([
        {
          organization_id: "d2000000-0000-0000-0000-000000000682",
          product: "hotel_catalog",
          resource_type: "property",
          resource_id: "d3000000-0000-0000-0000-000000000682",
          relationship: "owner",
          status: "active",
        },
      ]);
    } finally {
      await client.end();
    }
  });
});
