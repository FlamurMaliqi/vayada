import { describe, expect, expectTypeOf, it } from "vitest";

import {
  FINANCE_FOLIO_STORED_STATES,
  FINANCE_FOLIO_VIEW_STATES,
  parseFinanceFolioQuery,
  type FinanceFolio,
} from "./financialFolios.js";

describe("Financials folio read contract", () => {
  it("keeps operational and derived states separate from official invoice lifecycle", () => {
    expect(FINANCE_FOLIO_STORED_STATES).toEqual(["draft", "ready", "archived"]);
    expect(FINANCE_FOLIO_VIEW_STATES).toEqual(["draft", "ready", "archived", "superseded"]);
    expect(FINANCE_FOLIO_VIEW_STATES).not.toContain("issued");
    expect(FINANCE_FOLIO_VIEW_STATES).not.toContain("paid");
    expect(FINANCE_FOLIO_VIEW_STATES).not.toContain("overdue");
    expect(FINANCE_FOLIO_VIEW_STATES).not.toContain("void");
  });

  it("models normalized source and payment evidence without official invoice fields", () => {
    expectTypeOf<FinanceFolio>().toMatchTypeOf<{
      folioId: string;
      propertyId: string;
      recipient: { name: string; email: string | null };
      lines: Array<{
        quantity: string;
        unitAmount: { amount: string; currency: string };
        total: { amount: string; currency: string };
        source: { type: string; id: string; revision: number };
      }>;
      paymentRefs: Array<{ paymentId: string; amount: { amount: string; currency: string } }>;
      sourceDigest: string;
    }>();
    expectTypeOf<FinanceFolio>().not.toHaveProperty("invoiceNumber");
    expectTypeOf<FinanceFolio>().not.toHaveProperty("documentUrl");
  });

  it("normalizes documented list defaults and filters", () => {
    expect(
      parseFinanceFolioQuery({
        from: "2026-08-01",
        to: "2026-08-31",
        state: "ready",
        search: "Guest booking",
        cursor: "eyJ2IjoxfQ",
        limit: "25",
        sort: "amount_desc",
      }),
    ).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
      state: "ready",
      search: "Guest booking",
      cursor: "eyJ2IjoxfQ",
      limit: 25,
      sort: "amount_desc",
    });
    expect(parseFinanceFolioQuery({})).toEqual({ limit: 50, sort: "createdAt_desc" });
  });

  it.each([
    { from: "2026-08-31", to: "2026-08-01" },
    { from: "2026-02-30" },
    { state: "issued" },
    { search: " padded " },
    { cursor: "not a cursor!" },
    { limit: 201 },
    { sort: "officialNumber_desc" },
    { provider: "xero" },
  ])("rejects invalid, official-invoice, or provider query input", (query) => {
    expect(parseFinanceFolioQuery(query)).toBeNull();
  });
});
