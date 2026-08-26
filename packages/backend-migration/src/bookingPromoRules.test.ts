import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFile(
  join(import.meta.dirname, "../migrations/0107_booking_promo_rules.sql"),
  "utf8",
);

describe("booking promo rules migration", () => {
  it("uses property currency and stores the targeting and usage contract", async () => {
    const sql = await migration;

    expect(sql).toContain("DROP COLUMN currency");
    expect(sql).toContain("RENAME COLUMN use_count TO current_uses");
    expect(sql).toContain("ADD COLUMN min_booking_value NUMERIC(15, 2)");
    expect(sql).toContain("ADD COLUMN applicable_room_ids UUID[]");
    expect(sql).toContain("ADD COLUMN stay_date_from DATE");
    expect(sql).toContain("ADD COLUMN stay_date_until DATE");
    expect(sql).toContain("ALTER COLUMN max_uses SET NOT NULL");
  });

  it("binds quote and booking applications to a promo definition", async () => {
    const sql = await migration;

    expect(sql).toContain("ADD COLUMN promo_definition_id UUID");
    expect(sql).toContain("uq_promo_applications_guest_booking");
    expect(sql).toContain("WHERE guest_booking_id IS NOT NULL");
  });
});
