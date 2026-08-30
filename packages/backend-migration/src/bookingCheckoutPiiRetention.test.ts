import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../migrations/0122_booking_checkout_pii_retention.sql", import.meta.url),
  "utf8",
);

describe("Booking checkout PII retention migration", () => {
  it("adds an explicit draft PII retention deadline", () => {
    expect(sql).toContain("ALTER TABLE booking.checkout_contexts");
    expect(sql).toContain("ADD COLUMN pii_retention_until DATE");
    expect(sql).toContain("immutable legacy draft expiry date");
  });
});
