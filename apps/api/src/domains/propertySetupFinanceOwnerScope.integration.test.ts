import {
  FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
  type FinancePaymentReadinessReadPort,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION, parsePmsPricingCurrency } from "@vayada/domain-pms";
import pg, { type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPropertySetupFinanceOwnerScopePort } from "./propertySetupFinanceOwnerScope.js";
import { createPgFinancePaymentReadinessReadModel } from "./financePaymentReadinessReadModel.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = "19600000-0000-4000-8000-000000000001";
const propertyId = "19600000-0000-4000-8000-000000000002";

describe.skipIf(!TEST_DATABASE_URL)("Property setup Finance PostgreSQL owner scope", () => {
  const client = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const scope = createPgPropertySetupFinanceOwnerScopePort({ pool: client });
  const readiness: FinancePaymentReadinessReadPort = createPgFinancePaymentReadinessReadModel({
    connectionString: "postgresql://unused",
    pool: {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ) {
        const result = await client.query<T>(text, values ? [...values] : []);
        return { rows: result.rows, rowCount: result.rowCount };
      },
    },
    pricingReadPort: {
      async getPropertyPricingCurrency(requestedPropertyId) {
        return {
          contractVersion: PMS_PRICING_CONTRACT_VERSION,
          propertyId: requestedPropertyId,
          currency: parsePmsPricingCurrency("EUR")!,
          pricingCurrencyRevision: 7,
          createdAt: "2026-08-05T12:00:00.000Z",
          updatedAt: "2026-08-05T12:00:00.000Z",
        };
      },
    },
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1049 Finance Scope',
               'vay1049-finance-scope', 'active')`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay1049-finance-scope', 'VAY-1049 Finance Scope')`,
      [propertyId],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await client.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text)`,
      [organizationId, propertyId],
    );
    await client.query(
      `INSERT INTO pms.property_pricing_settings
         (property_id, currency, pricing_currency_revision)
       VALUES ($1::uuid, 'EUR', 7)`,
      [propertyId],
    );
  });

  afterAll(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  it("accepts aggregate-route owner relationships and rejects entitlement revocation", async () => {
    await expect(scope.hasPaymentOwnerScope({ organizationId, propertyId })).resolves.toBe(true);

    await client.query(
      `UPDATE identity.organization_resource_links
          SET relationship = 'front_desk'
        WHERE organization_id = $1::uuid
          AND product = 'pms'
          AND resource_id = $2::uuid::text`,
      [organizationId, propertyId],
    );
    await expect(scope.hasPaymentOwnerScope({ organizationId, propertyId })).resolves.toBe(false);

    await client.query(
      `UPDATE identity.organization_resource_links
          SET relationship = 'owner', status = 'suspended'
        WHERE organization_id = $1::uuid
          AND product = 'pms'
          AND resource_id = $2::uuid::text`,
      [organizationId, propertyId],
    );
    await expect(scope.hasPaymentOwnerScope({ organizationId, propertyId })).resolves.toBe(false);

    await client.query(
      `UPDATE identity.organization_resource_links
          SET status = 'active'
        WHERE organization_id = $1::uuid
          AND product = 'pms'
          AND resource_id = $2::uuid::text`,
      [organizationId, propertyId],
    );

    await client.query(
      `UPDATE identity.organization_resource_links
          SET relationship = 'operator'
        WHERE organization_id = $1::uuid
          AND product = 'pms'
          AND resource_id = $2::uuid::text`,
      [organizationId, propertyId],
    );
    await expect(scope.hasPaymentOwnerScope({ organizationId, propertyId })).resolves.toBe(true);

    await client.query(
      `UPDATE identity.organization_resource_links
          SET relationship = 'finance_manager'
        WHERE organization_id = $1::uuid
          AND product = 'pms'
          AND resource_id = $2::uuid::text`,
      [organizationId, propertyId],
    );
    await expect(scope.hasPaymentOwnerScope({ organizationId, propertyId })).resolves.toBe(true);

    await client.query(
      `UPDATE identity.product_entitlements
          SET status = 'suspended'
        WHERE organization_id = $1::uuid
          AND product = 'pms'
          AND entitlement_key = 'property-management'`,
      [organizationId],
    );
    await expect(scope.hasPaymentOwnerScope({ organizationId, propertyId })).resolves.toBe(false);
  });

  it("reads existing public-safe payment progress for an authorized PMS operator", async () => {
    await client.query(
      `UPDATE identity.organization_resource_links
          SET relationship = 'operator', status = 'active'
        WHERE organization_id = $1::uuid
          AND product = 'pms'
          AND resource_id = $2::uuid::text`,
      [organizationId, propertyId],
    );
    await client.query(
      `UPDATE identity.product_entitlements
          SET status = 'active'
        WHERE organization_id = $1::uuid
          AND product = 'pms'
          AND entitlement_key = 'property-management'`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO finance.payment_settings (
         property_id,
         payment_readiness_contract_version,
         payment_methods_revision,
         source_pricing_currency_revision,
         default_currency,
         accepted_methods
       ) VALUES ($1::uuid, $2, 3, 7, 'EUR', ARRAY['pay_at_property'])`,
      [propertyId, FINANCE_PAYMENT_READINESS_CONTRACT_VERSION],
    );

    await expect(scope.hasPaymentOwnerScope({ organizationId, propertyId })).resolves.toBe(true);
    await expect(
      readiness.getPaymentReadiness({ organizationId, propertyId }),
    ).resolves.toMatchObject({
      propertyId,
      paymentMethodsRevision: 3,
      selectedMethodCount: 1,
    });
  });
});

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
