import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0049_hotel_catalog_step1_profile.sql", import.meta.url),
  "utf8",
);

describe("Hotel Catalog Step 1 profile target schema", () => {
  it("persists explicit amenity review without inventing selected amenities", () => {
    expect(migration).toContain("CREATE TABLE hotel_catalog.property_amenity_review_state");
    expect(migration).toContain("property_id          UUID        PRIMARY KEY");
    expect(migration).toContain("REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE");
    expect(migration).toContain(
      "reviewed_by_user_id  UUID        NOT NULL REFERENCES identity.users(id)",
    );
    expect(migration).not.toContain("INSERT INTO hotel_catalog.property_amenity_review_state");
  });

  it("keeps review and update timestamps explicitly ordered", () => {
    expect(migration).toContain("reviewed_at          TIMESTAMPTZ NOT NULL");
    expect(migration).toContain("updated_at           TIMESTAMPTZ NOT NULL");
    expect(migration).toContain("CHECK (updated_at >= reviewed_at)");
  });
});
