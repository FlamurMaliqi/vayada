import { describe, expect, expectTypeOf, it } from "vitest";

import {
  buildFinanceFolioCsvArtifact,
  FINANCE_FOLIO_CSV_COLUMNS,
  FinanceFolioCsvError,
  FINANCE_FOLIO_STORED_STATES,
  FINANCE_FOLIO_VIEW_STATES,
  parseFinanceFolioExportSnapshot,
  parseFinanceFolioQuery,
  parseFinanceFolioRevisionCommand,
  parseFinanceFolioWrite,
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

  it("normalizes a strict correction payload without accepting client-derived evidence", () => {
    const parsed = parseFinanceFolioWrite(folioWrite(), "correct");

    expect(parsed).toMatchObject({
      expectedRevision: 2,
      bookingId: "11320000-0000-4000-8000-000000000004",
      lines: [
        { position: 1, quantity: "2.0000", unitAmount: { amount: "-1.5000" } },
        { position: 2, quantity: "1.0000", unitAmount: { amount: "12.0000" } },
      ],
      paymentRefs: [
        { paymentId: "11320000-0000-4000-8000-000000000006", amount: { amount: "2.0000" } },
        { paymentId: "11320000-0000-4000-8000-000000000007", amount: { amount: "10.0000" } },
      ],
    });
    expect(parsed!.lines[0]).not.toHaveProperty("lineId");
    expect(parsed!.lines[0]).not.toHaveProperty("total");
  });

  it("separates create and immutable revision commands", () => {
    const { expectedRevision: _expectedRevision, ...create } = folioWrite();
    expect(parseFinanceFolioWrite(create, "create")).not.toBeNull();
    expect(parseFinanceFolioWrite(folioWrite(), "create")).toBeNull();
    expect(parseFinanceFolioWrite(create, "correct")).toBeNull();
    expect(
      parseFinanceFolioRevisionCommand({
        commandId: "11320000-0000-4000-8000-000000000010",
        idempotencyKey: "ready-1",
        expectedRevision: 2,
      }),
    ).toEqual({
      commandId: "11320000-0000-4000-8000-000000000010",
      idempotencyKey: "ready-1",
      expectedRevision: 2,
    });
    expect(
      parseFinanceFolioRevisionCommand({
        commandId: "11320000-0000-4000-8000-000000000010",
        idempotencyKey: "ready-1",
        expectedRevision: 2,
        recipient: { name: "leak", email: null },
      }),
    ).toBeNull();
  });

  it.each([
    [
      "client total",
      (value: any) => (value.lines[0].total = { amount: "12.0000", currency: "EUR" }),
    ],
    [
      "client line id",
      (value: any) => (value.lines[0].lineId = "11320000-0000-4000-8000-000000000099"),
    ],
    ["mixed currency", (value: any) => (value.paymentRefs[0].amount.currency = "USD")],
    ["service interval", (value: any) => (value.lines[0].serviceOn = "2026-08-22")],
    ["source", (value: any) => (value.lines[0].source.id = "bad source")],
    ["decimal scale", (value: any) => (value.lines[0].quantity = "1.00001")],
    [
      "line total overflow",
      (value: any) => {
        value.lines[0].quantity = "999999999999999";
        value.lines[0].unitAmount.amount = "999999999999999";
      },
    ],
    ["negative folio total", (value: any) => (value.lines[1].unitAmount.amount = "-13")],
    [
      "folio total overflow",
      (value: any) => {
        value.lines[0].quantity = "1";
        value.lines[0].unitAmount.amount = "600000000000000";
        value.lines[1].quantity = "1";
        value.lines[1].unitAmount.amount = "600000000000000";
      },
    ],
    ["duplicate line position", (value: any) => (value.lines[0].position = 1)],
    [
      "duplicate payment",
      (value: any) => (value.paymentRefs[0].paymentId = value.paymentRefs[1].paymentId),
    ],
    ["recipient shape", (value: any) => (value.recipient.version = 1)],
    ["recipient control character", (value: any) => (value.recipient.name = "Ada\nLovelace")],
    ["recipient byte limit", (value: any) => (value.recipient.name = "é".repeat(3_000))],
    ["idempotency control character", (value: any) => (value.idempotencyKey = "folio\n1")],
    ["official invoice field", (value: any) => (value.invoiceNumber = "INV-1")],
  ])("rejects unsafe %s evidence", (_label, change) => {
    const value = folioWrite();
    change(value);
    expect(parseFinanceFolioWrite(value, "correct")).toBeNull();
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

  it("accepts only exact ready export manifests with unique revision evidence", () => {
    const selected = {
      folioId: "11320000-0000-4000-8000-000000000003",
      revisionId: "11320000-0000-4000-8000-000000000009",
      revision: 2,
      sourceDigest: "a".repeat(64),
    };
    const snapshot = {
      formatVersion: "pms-financials-folios.v1",
      propertyId: "11320000-0000-4000-8000-000000000001",
      currency: "EUR",
      filters: { state: "ready", sort: "createdAt_desc" },
      snapshotAt: "2026-08-21T10:00:00.000Z",
      manifest: [selected],
    };
    expect(parseFinanceFolioExportSnapshot(snapshot)).toEqual(snapshot);
    expect(
      parseFinanceFolioExportSnapshot({
        ...snapshot,
        filters: { ...snapshot.filters, cursor: "eA" },
      }),
    ).toBeNull();
    expect(
      parseFinanceFolioExportSnapshot({ ...snapshot, manifest: [selected, selected] }),
    ).toBeNull();
    expect(
      parseFinanceFolioExportSnapshot({
        ...snapshot,
        manifest: [{ ...selected, sourceDigest: "tampered" }],
      }),
    ).toBeNull();
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

  it("rejects a folio whose total does not reconcile with valid line totals", () => {
    const folio = folioFixture();
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

function folioWrite() {
  return {
    commandId: "11320000-0000-4000-8000-000000000010",
    idempotencyKey: "folio-correction-1",
    expectedRevision: 2,
    bookingId: "11320000-0000-4000-8000-000000000004",
    recipient: { name: "Ada Lovelace", email: "ada@example.com" },
    serviceFrom: "2026-08-20",
    serviceTo: "2026-08-21",
    lines: [
      {
        position: 2,
        kind: "room",
        description: "Room stay",
        quantity: "1",
        unitAmount: { amount: "12", currency: "EUR" },
        serviceOn: "2026-08-20",
        source: { type: "booking_night", id: "booking:1", revision: 3 },
      },
      {
        position: 1,
        kind: "adjustment",
        description: "Correction",
        quantity: "2.0",
        unitAmount: { amount: "-1.5", currency: "EUR" },
        serviceOn: "2026-08-21",
        source: { type: "finance_adjustment", id: "adjustment:1", revision: 1 },
      },
    ],
    paymentRefs: [
      {
        paymentId: "11320000-0000-4000-8000-000000000007",
        amount: { amount: "10", currency: "EUR" },
      },
      {
        paymentId: "11320000-0000-4000-8000-000000000006",
        amount: { amount: "2", currency: "EUR" },
      },
    ],
  };
}
