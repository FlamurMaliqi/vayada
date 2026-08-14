import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0085_booking_admin_affiliate_management.sql"),
  "utf8",
);

describe("Booking Admin affiliate management migration", () => {
  it("creates Marketplace lifecycle ownership and Finance commission scopes", () => {
    expect(migration).toContain("CREATE TABLE marketplace.property_affiliates");
    expect(migration).toContain("CREATE TABLE marketplace.affiliate_lifecycle_changes");
    expect(migration).toContain("'marketplace.affiliate.manage'");
    expect(migration).toContain("ADD COLUMN affiliate_id TEXT");
    expect(migration).toContain("organization_id IS NOT NULL AND affiliate_id IS NULL");
    expect(migration).toContain("uq_finance_active_property_affiliate_override");
  });

  it("backfills only target public affiliate registration events", () => {
    expect(migration).toContain("marketplace.affiliate.public_registered");
    expect(migration).toContain("JOIN hotel_catalog.property_slugs");
    expect(migration).not.toMatch(/apps\/pms-api|PMS_DATABASE_URL|\baffiliates\s+a\b/i);
  });
});
