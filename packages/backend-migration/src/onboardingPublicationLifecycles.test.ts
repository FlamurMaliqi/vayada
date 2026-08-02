import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0046_onboarding_publication_lifecycles.sql", import.meta.url),
  "utf8",
);

describe("onboarding publication lifecycle target schema", () => {
  it("keeps both product revisions immutable and independently addressable", () => {
    expect(migration).toContain("marketplace.hotel_submission_revisions");
    expect(migration).toContain("distribution.public_booking_content_revisions");
    expect(migration.match(/platform\.prevent_append_only_mutation\(\)/g)).toHaveLength(4);
    expect(migration.match(/BEFORE TRUNCATE/g)).toHaveLength(2);
    expect(migration).toContain("marketplace.active_hotel_submission_revisions");
    expect(migration).toContain("CHECK (moderation_status = 'approved')");
    expect(migration).toContain("'active', 'suspended', 'deactivated'");
    expect(migration).toContain(
      "'pending', 'changes_requested', 'approved', 'rejected', 'withdrawn'",
    );
    expect(migration).toContain("CHECK (readiness_product = 'marketplace')");
    expect(migration).toContain("CHECK (readiness_product = 'booking')");
    expect(migration.match(/readiness_contract_version TEXT/g)).toHaveLength(2);
    expect(migration.match(/onboarding-product-readiness\.v1/g)).toHaveLength(2);
    expect(migration.match(/CHECK \(readiness_status = 'ready'\)/g)).toHaveLength(2);
    expect(migration.match(/jsonb_array_length\(source_manifest->'sources'\) > 0/g)).toHaveLength(
      2,
    );
    expect(migration).toContain("distribution.jsonb_has_distribution_private_key(public_content)");
    expect(migration).toContain("distribution.active_public_booking_revision");
  });

  it("stores the live ARI watermark outside Booking content revisions", () => {
    const ariStart = migration.indexOf("distribution.live_ari_watermarks");
    const ariEnd = migration.indexOf("\n);", ariStart);
    expect(ariStart).toBeGreaterThan(-1);
    expect(ariEnd).toBeGreaterThan(ariStart);
    const ariTable = migration.slice(ariStart, ariEnd + 3);
    expect(ariTable).toContain("source_revision");
    expect(ariTable).toContain("watermark_revision");
    expect(ariTable).not.toContain("content_revision_id");
  });

  it("does not expose private Marketplace moderation state", () => {
    expect(migration).not.toMatch(
      /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW[\s\S]*marketplace\.hotel_submission_(?:revisions|moderation)/i,
    );
    expect(migration).not.toMatch(
      /GRANT\s+SELECT\s+ON\s+(?:TABLE\s+)?marketplace\.hotel_submission_(?:revisions|moderation)/i,
    );
  });
});
