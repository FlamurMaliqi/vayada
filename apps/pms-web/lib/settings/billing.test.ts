import { describe, expect, it } from "vitest";

import { formatBillingAmount, formatInvoiceDate } from "./billing";

describe("billing formatting", () => {
  it("uses the property currency and suppresses IDR decimals", () => {
    const formatted = formatBillingAmount(98_000_000, "IDR");
    expect(formatted).toContain("980");
    expect(formatted).not.toMatch(/[.,]00\b/);
  });

  it("falls back to the plain minor-unit amount for malformed currencies", () => {
    expect(formatBillingAmount(6_000, "US")).toBe("6000");
    expect(formatBillingAmount(6_000, undefined as unknown as string)).toBe("6000");
  });

  it("formats invoice dates as DD.MM.YYYY", () => {
    expect(formatInvoiceDate("2026-09-05T01:02:03.000Z")).toBe("05.09.2026");
  });
});
