import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0138_marketplace_creator_matching_preferences.sql", import.meta.url),
  ),
  "utf8",
);

describe("Marketplace creator matching preferences migration", () => {
  it("keeps existing creator preferences unknown", () => {
    expect(migration).not.toMatch(/\b(?:UPDATE|INSERT INTO)\s+marketplace\.creator_profiles\b/i);
  });

  it("owns one versioned and audited preference document per creator", () => {
    expect(migration).toContain("CREATE TABLE marketplace.creator_matching_preferences");
    expect(migration).toContain("creator_profile_id  UUID        PRIMARY KEY");
    expect(migration).toContain("marketplace-creator-matching-preferences.v1");
    expect(migration).toContain("updated_by_user_id  UUID        NOT NULL");
    expect(migration).toContain("revision <> OLD.revision + 1");
    expect(migration).toContain("FOREIGN KEY (creator_profile_id, organization_id)");
  });

  it("allows only the approved top-level fields", () => {
    for (const field of [
      "contentCategories",
      "deliverableTypes",
      "compensationTypes",
      "collaborationGoals",
      "travel",
    ]) {
      expect(migration).toContain(`'${field}'`);
    }
    expect(migration).toContain("preferences - ARRAY[");
  });
});
