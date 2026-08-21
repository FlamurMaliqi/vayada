import pg, { type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPmsPricingReadModel } from "./pmsPricingReadModel.js";
import {
  createPgFinanceFolioReadRepository,
  FinanceFolioCursorError,
  FinanceFolioEvidenceError,
  type FinanceFolioReadPool,
} from "./financeFolioReadRepository.js";
import type { FinanceFolioRecipientDecoderInput } from "./financeFolioRecipientCodec.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "11320000-0000-4000-8000-000000000001",
  EMPTY = "11320000-0000-4000-8000-000000000002",
  OTHER = "11320000-0000-4000-8000-000000000003";
const FOLIO = "11320000-0000-4000-8000-000000000004",
  SECOND = "11320000-0000-4000-8000-000000000005",
  PAYMENT = "11320000-0000-4000-8000-000000000006";
const REVISION_1 = "11320000-0000-4000-8000-000000000011",
  REVISION_2 = "11320000-0000-4000-8000-000000000012",
  SECOND_REVISION = "11320000-0000-4000-8000-000000000013";
const properties = [PROPERTY, EMPTY, OTHER];
const SCOPES = properties.map((id) => `'${id}'`).join(",");
const propertyContext = {
  async getPropertyContext(propertyId: string) {
    return properties.includes(propertyId)
      ? {
          source: {
            ownerDomain: "hotel_catalog" as const,
            entityType: "property_profile" as const,
            entityId: propertyId,
            revision: "profile:1",
          },
          timeZone: "Europe/Berlin",
          updatedAt: "2026-08-20T08:00:00.000Z",
        }
      : null;
  },
};

// prettier-ignore
describe.skipIf(!URL)("PostgreSQL Finance folio read repository", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const pricing = createPgPmsPricingReadModel({ connectionString: URL ?? "postgresql://disabled" });
  const recipientInputs: FinanceFolioRecipientDecoderInput[] = [];
  const read = createPgFinanceFolioReadRepository({ connectionString: URL, pricing, propertyContext, recipientDecoder: { async decode(input) { recipientInputs.push(input); return { name: "Ada Lovelace", email: "ada@example.com", taxId: "must-not-leak" }; } }, now: () => new Date("2026-08-20T10:00:00.000Z") });
  beforeAll(async () => {
    await admin.connect(); await cleanup();
    await admin.query(`INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ('${PROPERTY}','folio-read','Folio read'),('${EMPTY}','folio-empty','Folio empty'),('${OTHER}','folio-other','Folio other');
      INSERT INTO pms.property_pricing_settings (property_id,currency) VALUES ('${PROPERTY}','EUR'),('${EMPTY}','EUR'),('${OTHER}','USD');
      INSERT INTO finance.folios (id,property_id,created_at) VALUES ('${FOLIO}','${PROPERTY}','2026-08-19T08:00:00Z'),('${SECOND}','${PROPERTY}','2026-08-19T08:00:00Z'),('11320000-0000-4000-8000-000000000007','${PROPERTY}','2026-08-19T08:00:00Z');
      INSERT INTO finance.payments (id,property_id,payment_kind,status,amount,currency) VALUES ('${PAYMENT}','${PROPERTY}','full','paid',12,'EUR');
      BEGIN;
      INSERT INTO finance.folio_revisions (id,folio_id,property_id,revision,state,recipient_snapshot_ciphertext,recipient_encryption_scheme,recipient_key_version,recipient_fingerprint,recipient_fingerprint_key_version,service_from,service_to,currency,total_amount,source_digest,source_freshness,created_at) VALUES
        ('${REVISION_1}','${FOLIO}','${PROPERTY}',1,'draft',decode(repeat('ab',32),'hex'),'envelope_aead_v1','key-1',repeat('a',64),'fingerprint-1','2026-08-01','2026-08-02','EUR',10,repeat('b',64),'{"booking":"2026-08-19T07:00:00.000Z"}','2026-08-19T09:00:00Z'),
        ('${REVISION_2}','${FOLIO}','${PROPERTY}',2,'ready',decode(repeat('ab',32),'hex'),'envelope_aead_v1','key-1',repeat('a',64),'fingerprint-1','2026-08-01','2026-08-02','EUR',12,repeat('c',64),'{"booking":"2026-08-20T07:00:00.000Z"}','2026-08-20T09:00:00.000100Z'),
        ('${SECOND_REVISION}','${SECOND}','${PROPERTY}',1,'ready',decode(repeat('ab',32),'hex'),'envelope_aead_v1','key-1',repeat('a',64),'fingerprint-1','2026-08-03','2026-08-03','EUR',5,repeat('d',64),'{}','2026-08-20T09:00:00.000900Z'),
        ('11320000-0000-4000-8000-000000000014','11320000-0000-4000-8000-000000000007','${PROPERTY}',1,'draft',decode(repeat('ab',32),'hex'),'envelope_aead_v1','key-1',repeat('a',64),'fingerprint-1','2026-08-04','2026-08-04','EUR',0,repeat('e',64),'{}','2026-08-19T09:00:00Z'),
        ('11320000-0000-4000-8000-000000000015','11320000-0000-4000-8000-000000000007','${PROPERTY}',2,'archived',decode(repeat('ab',32),'hex'),'envelope_aead_v1','key-1',repeat('a',64),'fingerprint-1','2026-08-04','2026-08-04','EUR',0,repeat('e',64),'{"booking":"2026-02-31T00:00:00.000001Z"}','2026-08-20T09:00:00Z');
      INSERT INTO finance.folio_lines (folio_revision_id,folio_id,property_id,folio_revision,currency,position,kind,description,quantity,unit_amount,service_on,source_type,source_id,source_revision) VALUES
        ('${REVISION_1}','${FOLIO}','${PROPERTY}',1,'EUR',1,'room','Room',1,10,'2026-08-01','booking','booking:1',1),
        ('${REVISION_2}','${FOLIO}','${PROPERTY}',2,'EUR',1,'room','Room',1.5,8,'2026-08-01','booking','booking:1',2),
        ('${SECOND_REVISION}','${SECOND}','${PROPERTY}',1,'EUR',1,'fee','Fee',1,5,'2026-08-03','finance','fee:1',1);
      INSERT INTO finance.folio_payment_references (folio_revision_id,folio_id,property_id,folio_revision,currency,position,payment_id,amount) VALUES ('${REVISION_2}','${FOLIO}','${PROPERTY}',2,'EUR',1,'${PAYMENT}',12); COMMIT;`);
  });
  afterAll(async () => { await read.close(); await pricing.close(); await cleanup(); await admin.end(); });

  it("returns scoped latest detail, normalized evidence, a recipient whitelist, and zero state", async () => {
    await expect(read.detail(OTHER, FOLIO)).resolves.toBeNull();
    const result = await read.detail(PROPERTY, FOLIO);
    expect(result).toMatchObject({ contractVersion: "pms-financials.v1", propertyId: PROPERTY, currency: "EUR", timeZone: "Europe/Berlin", item: { folioId: FOLIO, revision: 2, state: "ready", recipient: { name: "Ada Lovelace", email: "ada@example.com" }, total: { amount: "12.0000", currency: "EUR" }, lines: [{ quantity: "1.5000", unitAmount: { amount: "8.0000" }, total: { amount: "12.0000" } }], paymentRefs: [{ paymentId: PAYMENT, amount: { amount: "12.0000" } }], sourceFreshness: { booking: "2026-08-20T07:00:00.000Z" } } });
    expect(recipientInputs.at(-1)).toMatchObject({ propertyId: PROPERTY, folioId: FOLIO, revision: 2, encryptionScheme: "envelope_aead_v1", keyVersion: "key-1" });
    const corruptPool: FinanceFolioReadPool = { async query<T extends QueryResultRow>(sql: string, values?: readonly unknown[]) { const result = await admin.query(sql, values as unknown[]); return { rows: result.rows.map((row) => Object.hasOwn(row, "serviceFrom") ? { ...row, serviceFrom: "2026-08-03", serviceTo: "2026-08-02" } : row) as T[] }; } }; const corrupt = createPgFinanceFolioReadRepository({ pool: corruptPool, pricing, propertyContext, recipientDecoder: { async decode() { return { name: "Ada", email: null }; } } }); await expect(corrupt.detail(PROPERTY, FOLIO)).rejects.toBeInstanceOf(FinanceFolioEvidenceError); await corrupt.close();
    expect(Object.keys(result!.item.recipient)).toEqual(["name", "email"]);
    await expect(read.detail(PROPERTY, "11320000-0000-4000-8000-000000000007")).rejects.toBeInstanceOf(FinanceFolioEvidenceError);
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica; UPDATE finance.folio_revisions SET source_freshness='{"minimum":"0001-01-01T00:00:00.000001Z","early":"0999-12-31T23:59:59.999999Z"}'::jsonb WHERE id='11320000-0000-4000-8000-000000000015'; COMMIT`); await expect(read.detail(PROPERTY, "11320000-0000-4000-8000-000000000007")).resolves.toMatchObject({ item: { sourceFreshness: { minimum: "0001-01-01T00:00:00.000001Z", early: "0999-12-31T23:59:59.999999Z" } } });
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica; UPDATE finance.folio_revisions SET source_freshness='{"booking":"0000-01-01T00:00:00.000001Z"}'::jsonb WHERE id='11320000-0000-4000-8000-000000000015'; COMMIT`); await expect(read.detail(PROPERTY, "11320000-0000-4000-8000-000000000007")).rejects.toBeInstanceOf(FinanceFolioEvidenceError);
    await expect(read.list(EMPTY, { sort: "createdAt_desc", limit: 50 })).resolves.toMatchObject({ sourceFreshness: { pmsPricing: expect.any(String), hotelCatalog: expect.any(String) }, page: { items: [], nextCursor: null, limit: 50 } });
  });

  it("derives superseded state and keeps semantic cursors bound to scope, filters, and sort", async () => {
    await expect(read.list(PROPERTY, { state: "superseded", sort: "createdAt_desc", limit: 10 })).resolves.toMatchObject({ page: { items: [{ folioId: FOLIO, revision: 1, state: "superseded" }, { folioId: "11320000-0000-4000-8000-000000000007", revision: 1, state: "superseded" }] } });
    await expect(read.list(PROPERTY, { state: "archived", sort: "createdAt_desc", limit: 10 })).resolves.toMatchObject({ page: { items: [{ folioId: "11320000-0000-4000-8000-000000000007", state: "archived" }] } });
    const first = await read.list(PROPERTY, { from: "2026-08-01", to: "2026-08-03", sort: "createdAt_desc", limit: 1 });
    expect(first?.page.items).toMatchObject([{ folioId: SECOND, revision: 1 }]);
    await expect(read.list(PROPERTY, { from: "2026-08-01", to: "2026-08-03", sort: "createdAt_desc", limit: 1, cursor: first!.page.nextCursor! })).resolves.toMatchObject({ page: { items: [{ folioId: FOLIO, revision: 2 }] } });
    const forged = JSON.parse(Buffer.from(first!.page.nextCursor!, "base64url").toString("utf8")); forged.p[0] = "2026-02-31T00:00:00.000001Z"; await expect(read.list(PROPERTY, { from: "2026-08-01", to: "2026-08-03", sort: "createdAt_desc", limit: 1, cursor: Buffer.from(JSON.stringify(forged)).toString("base64url") })).rejects.toBeInstanceOf(FinanceFolioCursorError); forged.p[0] = "0001-01-01T00:00:00.000001Z"; await expect(read.list(PROPERTY, { from: "2026-08-01", to: "2026-08-03", sort: "createdAt_desc", limit: 1, cursor: Buffer.from(JSON.stringify(forged)).toString("base64url") })).resolves.toMatchObject({ page: { items: [] } }); forged.p[0] = "0999-12-31T23:59:59.999999Z"; await expect(read.list(PROPERTY, { from: "2026-08-01", to: "2026-08-03", sort: "createdAt_desc", limit: 1, cursor: Buffer.from(JSON.stringify(forged)).toString("base64url") })).resolves.toMatchObject({ page: { items: [] } }); forged.p[0] = "0000-01-01T00:00:00.000001Z"; await expect(read.list(PROPERTY, { from: "2026-08-01", to: "2026-08-03", sort: "createdAt_desc", limit: 1, cursor: Buffer.from(JSON.stringify(forged)).toString("base64url") })).rejects.toBeInstanceOf(FinanceFolioCursorError);
    await expect(read.list(OTHER, { from: "2026-08-01", to: "2026-08-03", sort: "createdAt_desc", limit: 1, cursor: first!.page.nextCursor! })).rejects.toBeInstanceOf(FinanceFolioCursorError);
    await expect(read.list(PROPERTY, { from: "2026-08-01", to: "2026-08-03", sort: "amount_desc", limit: 1, cursor: first!.page.nextCursor! })).rejects.toBeInstanceOf(FinanceFolioCursorError);
    await expect(read.list(PROPERTY, { search: FOLIO, sort: "createdAt_desc", limit: 10 })).resolves.toMatchObject({ page: { items: [{ folioId: FOLIO, revision: 2 }] } });
  });

  async function cleanup() { await admin.query(`BEGIN; SET LOCAL session_replication_role=replica; DELETE FROM finance.folio_payment_references WHERE property_id IN (${SCOPES}); DELETE FROM finance.folio_lines WHERE property_id IN (${SCOPES}); DELETE FROM finance.folio_revisions WHERE property_id IN (${SCOPES}); DELETE FROM finance.folios WHERE property_id IN (${SCOPES}); DELETE FROM finance.payments WHERE property_id IN (${SCOPES}); DELETE FROM pms.property_pricing_settings WHERE property_id IN (${SCOPES}); DELETE FROM hotel_catalog.properties WHERE id IN (${SCOPES}); COMMIT`); }
});
