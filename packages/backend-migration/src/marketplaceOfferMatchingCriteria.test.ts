import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0136_marketplace_offer_matching_criteria.sql", import.meta.url),
  ),
  "utf8",
);

describe("Marketplace offer matching criteria migration", () => {
  it("keeps legacy requirement levels and criteria unknown", () => {
    expect(migration).toContain("ADD COLUMN requirement_level TEXT");
    expect(migration).toContain("ADD COLUMN follower_requirement_level TEXT");
    expect(migration).toContain("ADD COLUMN platform_requirement_level TEXT");
    expect(migration).not.toMatch(
      /\b(?:UPDATE|INSERT INTO)\s+marketplace\.(?:marketplace_offers|offer_deliverables|offer_compensation_options|offer_creator_requirements)\b/i,
    );
  });

  it("owns one versioned, audited criteria aggregate per offer", () => {
    expect(migration).toContain("CREATE TABLE marketplace.offer_matching_criteria");
    expect(migration).toContain("offer_id            UUID        PRIMARY KEY");
    expect(migration).toContain("marketplace-offer-matching-criteria.v1");
    expect(migration).toContain(
      "updated_by_user_id  UUID        NOT NULL REFERENCES identity.users(id)",
    );
    expect(migration).toContain("revision <> OLD.revision + 1");
    expect(migration).toContain("FOREIGN KEY (offer_id, property_id, organization_id)");
    expect(migration).toContain("AND cardinality(platforms) > 0");
    expect(migration).toContain("OR COALESCE(cardinality(target_countries), 0) > 0");
  });

  it("constrains the document to the approved top-level fields", () => {
    for (const field of [
      "primaryCampaignGoal",
      "availability",
      "contentCategories",
      "contentStyles",
      "usageRights",
      "includedRevisionRounds",
      "expectedEffortHours",
      "expectedCompensationValue",
      "applicationCapacity",
    ]) {
      expect(migration).toContain(`'${field}'`);
    }
    expect(migration).toContain("criteria - ARRAY[");
  });
});
