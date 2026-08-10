import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0061_booking_header_logo.sql"),
  "utf8",
);
const platformMediaParity = await readFile(
  join(import.meta.dirname, "cases/platformMedia/parity.ts"),
  "utf8",
);
const platformMediaExpectedTarget = await readFile(
  join(import.meta.dirname, "../fixtures/cases/platform-media/expected-target.json"),
  "utf8",
);
const mediaUrlExpectedTarget = await readFile(
  join(import.meta.dirname, "../fixtures/cases/media-url-migration/expected-target.json"),
  "utf8",
);

describe("Booking header logo migration", () => {
  it("adds a nullable Booking-owned opt-in without changing existing properties", () => {
    expect(migration).toContain("ALTER TABLE booking.booking_settings");
    expect(migration).toContain("ADD COLUMN header_logo_url TEXT");
    expect(migration).toContain("'booking.header_logo'");
    expect(migration).toContain("THEN media_visibility = 'public'");
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION platform.valid_media_purpose_visibility",
    );
    expect(migration).toContain("NULL preserves the property-name fallback");
    expect(migration).not.toMatch(/\b(?:UPDATE|INSERT INTO)\s+booking\.booking_settings\b/i);
    expect(migration).not.toContain("NOT NULL");
  });

  it("requires Booking header logos and their public variants in migration parity", () => {
    expect(platformMediaParity.match(/booking\.header_logo/g)).toHaveLength(2);
    expect(platformMediaExpectedTarget).toContain('"booking.header_logo"');
    expect(mediaUrlExpectedTarget).toContain('"booking.header_logo"');
  });
});
