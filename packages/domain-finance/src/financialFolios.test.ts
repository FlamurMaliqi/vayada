import { describe, expect, expectTypeOf, it } from "vitest";

import {
  buildFinanceFolioCsvArtifact,
  FINANCE_FOLIO_CSV_COLUMNS,
  FinanceFolioCsvError,
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

  it("builds the stable ready-folio CSV without provider or uncontracted fields", () => {
    const folio = folioFixture();
    const artifact = buildFinanceFolioCsvArtifact({
      propertyId: folio.propertyId,
      currency: folio.currency,
      folios: [folio],
    });
    const rows = artifact.body.trimEnd().split("\r\n");

    expect(artifact).toMatchObject({
      formatVersion: "pms-financials-folios.v1",
      contentType: "text/csv; charset=utf-8",
      filename: `pms-financials-folios-${folio.propertyId}.csv`,
      rowCount: 2,
      auditEvidence: [{ folioId: folio.folioId, revision: 2, sourceDigest: "a".repeat(64) }],
    });
    expect(rows[0]).toBe(FINANCE_FOLIO_CSV_COLUMNS.map((value) => `"${value}"`).join(","));
    expect(rows[1]).toContain('"1","adjustment","\'@SUM(1,1)"');
    expect(rows[1]).toContain('"-5.0000","-5.0000"');
    expect(rows[2]).toContain('"2","room","Room ""special"", breakfast"');
    expect(rows[1]).toContain(
      '"11320000-0000-4000-8000-000000000006;11320000-0000-4000-8000-000000000007","2.0000;10.0000"',
    );
    expect(artifact.body).toContain('"\'=HYPERLINK(""https://bad"")"');
    expect(artifact.body).toContain('"\'+guest@example.com"');
    expect(artifact.body).not.toContain("providerSecret");
    expect(folio.lines.map((line) => line.position)).toEqual([2, 1]);
  });

  it.each([
    { change: { state: "draft" }, label: "draft" },
    { change: { propertyId: "11320000-0000-4000-8000-000000000099" }, label: "property" },
    { change: { currency: "USD" }, label: "currency" },
    { change: { lines: [] }, label: "empty lines" },
  ])("rejects $label evidence from a ready accounting handoff", ({ change }) => {
    const folio = { ...folioFixture(), ...change } as FinanceFolio;
    expect(() =>
      buildFinanceFolioCsvArtifact({
        propertyId: "11320000-0000-4000-8000-000000000001",
        currency: "EUR",
        folios: [folio],
      }),
    ).toThrow(FinanceFolioCsvError);
  });

  it("rejects duplicate page evidence instead of duplicating CSV rows", () => {
    const folio = folioFixture();
    expect(() =>
      buildFinanceFolioCsvArtifact({
        propertyId: folio.propertyId,
        currency: folio.currency,
        folios: [folio, folio],
      }),
    ).toThrow(FinanceFolioCsvError);
  });

  it("rejects a port result whose decimal line arithmetic is inconsistent", () => {
    const folio = folioFixture();
    folio.lines[0]!.total.amount = "11.0000";
    folio.total.amount = "6.0000";
    expect(() =>
      buildFinanceFolioCsvArtifact({
        propertyId: folio.propertyId,
        currency: folio.currency,
        folios: [folio],
      }),
    ).toThrow(FinanceFolioCsvError);
  });
});

function folioFixture(): FinanceFolio {
  const propertyId = "11320000-0000-4000-8000-000000000001";
  const currency = "EUR";
  return {
    folioId: "11320000-0000-4000-8000-000000000003",
    propertyId,
    bookingId: "11320000-0000-4000-8000-000000000004",
    revision: 2,
    state: "ready",
    recipient: { name: '=HYPERLINK("https://bad")', email: "+guest@example.com" },
    serviceFrom: "2026-08-20",
    serviceTo: "2026-08-21",
    currency,
    lines: [
      {
        lineId: "11320000-0000-4000-8000-000000000005",
        position: 2,
        kind: "room",
        description: 'Room "special", breakfast',
        quantity: "1.0000",
        unitAmount: { amount: "12.0000", currency },
        total: { amount: "12.0000", currency },
        serviceOn: "2026-08-20",
        source: { type: "booking_night", id: "booking:1", revision: 3 },
      },
      {
        lineId: "11320000-0000-4000-8000-000000000008",
        position: 1,
        kind: "adjustment",
        description: "@SUM(1,1)",
        quantity: "1.0000",
        unitAmount: { amount: "-5.0000", currency },
        total: { amount: "-5.0000", currency },
        serviceOn: "2026-08-20",
        source: { type: "finance_adjustment", id: "adjustment:1", revision: 1 },
      },
    ],
    total: { amount: "7.0000", currency },
    paymentRefs: [
      {
        paymentId: "11320000-0000-4000-8000-000000000007",
        amount: { amount: "10.0000", currency },
      },
      {
        paymentId: "11320000-0000-4000-8000-000000000006",
        amount: { amount: "2.0000", currency },
      },
    ],
    sourceDigest: "a".repeat(64),
    sourceFreshness: { booking: "2026-08-20T10:00:00.000Z" },
    createdAt: "2026-08-20T10:00:00.000Z",
    providerSecret: "must-not-export",
  } as FinanceFolio;
}
