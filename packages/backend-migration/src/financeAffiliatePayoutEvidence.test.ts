import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0086_finance_affiliate_payout_payment_evidence.sql"),
  "utf8",
);
const financeTransform = await readFile(
  join(import.meta.dirname, "cases/finance/transform.ts"),
  "utf8",
);

describe("Finance affiliate payout evidence migration", () => {
  it("adds the Platform Finance command grant and scoped entitlement", () => {
    expect(migration).toContain("'platform.finance.manage'");
    expect(migration).toContain("'platform_admin', 'platform.finance.manage'");
    expect(migration).toContain("'finance_manager', 'platform.finance.manage'");
    expect(migration).toContain("'platform', 'finance-admin', 'active'");
    expect(migration).toContain("'platform', 'platform', 'vayada'");
  });

  it("stores immutable command evidence and exact payout snapshots", () => {
    expect(migration).toContain("CREATE TABLE finance.affiliate_payout_payment_evidence (");
    expect(migration).toContain("CREATE TABLE finance.affiliate_payout_payment_evidence_items (");
    expect(migration).toContain("UNIQUE (idempotency_key_id)");
    expect(migration).toContain("UNIQUE (payout_id)");
    expect(migration).toContain("organization_id, lower(external_reference)");
    expect(migration).toContain("validate_affiliate_payout_payment_evidence_item");
    expect(migration).toContain("payout.amount = NEW.amount");
    expect(migration).toContain("payout.currency = NEW.currency");
    expect(migration).toContain("payout.payout_metadata ->> 'resourceId'");
    expect(migration).toContain("COUNT(*) = evidence.payout_count");
    expect(migration).toContain("SUM(item.amount) = evidence.amount");
    expect(migration).toContain("BOOL_AND(item.currency = evidence.currency)");
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(2);
    expect(financeTransform).toContain(
      "payout_metadata || jsonb_build_object('affiliateId', affiliate_resource_id)",
    );
  });

  it("blocks update, delete, and truncate for evidence and item rows", () => {
    expect(migration.match(/platform\.prevent_append_only_mutation\(\)/g)).toHaveLength(4);
    expect(migration.match(/BEFORE UPDATE OR DELETE/g)).toHaveLength(2);
    expect(migration.match(/BEFORE TRUNCATE/g)).toHaveLength(2);
  });
});
