import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../migrations/0080_booking_acceptance_mode.sql", import.meta.url)),
  "utf8",
);

describe("booking acceptance mode migration", () => {
  it("adds the constrained canonical setting with the compatibility default", () => {
    expect(migration).toContain("ADD COLUMN acceptance_mode TEXT NOT NULL DEFAULT 'instant'");
    expect(migration).toContain("acceptance_mode IN ('instant', 'request')");
    expect(migration).not.toMatch(/\b(?:UPDATE|INSERT INTO)\s+booking\.guest_bookings\b/i);
  });
});
