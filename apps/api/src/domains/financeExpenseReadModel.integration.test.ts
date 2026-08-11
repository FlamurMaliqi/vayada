import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FinanceExpenseQuery } from "@vayada/domain-finance";
import { createPgPmsPricingReadModel } from "./pmsPricingReadModel.js";
import {
  createPgFinanceExpenseReadModel,
  FinanceExpenseCursorError,
} from "./financeExpenseReadModel.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "12130000-0000-4000-8000-000000000001";
const EMPTY = "12130000-0000-4000-8000-000000000002";
const OTHER = "12130000-0000-4000-8000-000000000003";
const CATEGORY = "12130000-0000-4000-8000-000000000004";
const SECOND_CATEGORY = "12130000-0000-4000-8000-000000000005";
const OTHER_CATEGORY = "12130000-0000-4000-8000-000000000006";
const RULE = "12130000-0000-4000-8000-000000000007";
const EXPENSE = "12130000-0000-4000-8000-000000000010";
const RECURRING = "12130000-0000-4000-8000-000000000011";
const SMALL = "12130000-0000-4000-8000-000000000012";
const CORRECTION = "12130000-0000-4000-8000-000000000014";
const MISMATCH = "12130000-0000-4000-8000-000000000018";
const propertyContext = {
  async getPropertyContext(propertyId: string) {
    return [PROPERTY, EMPTY, OTHER].includes(propertyId)
      ? {
          source: {
            ownerDomain: "hotel_catalog" as const,
            entityType: "property_profile" as const,
            entityId: propertyId,
            revision: "profile:1",
          },
          timeZone: propertyId === PROPERTY ? "America/Los_Angeles" : "Europe/Athens",
          updatedAt: "2026-08-11T09:00:00.000Z",
        }
      : null;
  },
};

// prettier-ignore
describe.skipIf(!URL)("PostgreSQL Finance expense read model", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const pricing = createPgPmsPricingReadModel({ connectionString: URL ?? "postgresql://disabled" });
  const read = createPgFinanceExpenseReadModel({ connectionString: URL, pricing, propertyContext, now: () => new Date("2026-08-11T10:00:00.000Z") });
  beforeAll(async () => {
    await admin.connect(); await cleanup();
    await admin.query(`INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES
      ('${PROPERTY}','expense-read','Expense read'),('${EMPTY}','expense-empty','Expense empty'),('${OTHER}','expense-other','Expense other');
      INSERT INTO hotel_catalog.property_locations (property_id,timezone) VALUES ('${PROPERTY}','America/Los_Angeles'),('${EMPTY}','Europe/Athens'),('${OTHER}','Europe/Athens');
      INSERT INTO pms.property_pricing_settings (property_id,currency) VALUES ('${PROPERTY}','EUR'),('${EMPTY}','EUR'),('${OTHER}','USD');
      INSERT INTO finance.expense_categories (id,property_id,name,color,sort_order) VALUES
        ('${CATEGORY}','${PROPERTY}','Operations','#123456',1),('${SECOND_CATEGORY}','${PROPERTY}','Utilities','#654321',2),('${OTHER_CATEGORY}','${OTHER}','Other','#111111',1);
      INSERT INTO finance.recurring_expense_rules (id,property_id,category_id,cadence,starts_on,next_due_on,vendor,amount,currency) VALUES
        ('${RULE}','${PROPERTY}','${SECOND_CATEGORY}','monthly','2026-08-01','2026-09-01','Recurring vendor',10,'EUR');
      INSERT INTO finance.expenses (id,property_id,category_id,origin,entry_kind,incurred_on,paid_on,vendor,amount,currency,payment_status,recurring_rule_id,source_key,reverses_expense_id) VALUES
        ('12130000-0000-4000-8000-000000000008','${PROPERTY}','${CATEGORY}','manual','expense','2026-07-05','2026-07-05','Prior Alpha',20,'EUR','paid',NULL,NULL,NULL),
        ('${EXPENSE}','${PROPERTY}','${CATEGORY}','manual','expense','2026-08-10',NULL,'Alpha vendor',30,'EUR','unpaid',NULL,NULL,NULL),
        ('${RECURRING}','${PROPERTY}','${SECOND_CATEGORY}','recurring','expense','2026-08-09','2026-08-09','Recurring vendor',10,'EUR','paid','${RULE}','rule:2026-08-09',NULL),
        ('${SMALL}','${PROPERTY}','${CATEGORY}','manual','expense','2026-08-09',NULL,'Alpha supplies',15,'EUR','unpaid',NULL,NULL,NULL),
        ('12130000-0000-4000-8000-000000000013','${PROPERTY}','${CATEGORY}','manual','expense','2026-07-08',NULL,'Old Alpha',40,'EUR','unpaid',NULL,NULL,NULL),
        ('${CORRECTION}','${PROPERTY}','${CATEGORY}','manual','correction','2026-08-08',NULL,'Corrected Alpha',50,'EUR','unpaid',NULL,'correction:14','12130000-0000-4000-8000-000000000013'),
        ('12130000-0000-4000-8000-000000000015','${PROPERTY}','${CATEGORY}','manual','expense','2026-07-07',NULL,'Archived',40,'EUR','unpaid',NULL,NULL,NULL),
        ('12130000-0000-4000-8000-000000000016','${PROPERTY}','${CATEGORY}','manual','reversal','2026-08-07',NULL,'Archived',40,'EUR','unpaid',NULL,'reversal:16','12130000-0000-4000-8000-000000000015'),
        ('12130000-0000-4000-8000-000000000017','${OTHER}','${OTHER_CATEGORY}','manual','expense','2026-08-10',NULL,'Other tenant',500,'USD','unpaid',NULL,NULL,NULL);
      SET session_replication_role=replica;
      INSERT INTO finance.expenses (id,property_id,category_id,origin,incurred_on,vendor,amount,currency) VALUES ('${MISMATCH}','${PROPERTY}','${CATEGORY}','manual','2026-08-10','Wrong currency',999,'USD');
      INSERT INTO finance.expenses (id,property_id,category_id,origin,incurred_on,vendor,amount,currency) VALUES ('12130000-0000-4000-8000-000000000019','${PROPERTY}','${CATEGORY}','manual','2026-10-10','Gap currency',5,'GBP');
      INSERT INTO booking.nightly_revenue_evidence (property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,source_revision,command_key) VALUES
        ('${PROPERTY}',gen_random_uuid(),gen_random_uuid(),'2026-08-10','2026-08-10','EUR',30,1,'room_night','confirmed','direct','exact',1,'read-current-1'),
        ('${PROPERTY}',gen_random_uuid(),gen_random_uuid(),'2026-08-09','2026-08-09','EUR',30,1,'room_night','confirmed','direct','exact',1,'read-current-2'),
        ('${PROPERTY}',gen_random_uuid(),gen_random_uuid(),'2026-08-08','2026-08-08','EUR',30,1,'room_night','confirmed','direct','exact',1,'read-current-3'),
        ('${PROPERTY}',gen_random_uuid(),gen_random_uuid(),'2026-07-05','2026-07-05','EUR',20,1,'room_night','completed','direct','exact',1,'read-prior-1'),
        ('${PROPERTY}',gen_random_uuid(),gen_random_uuid(),'2026-07-06','2026-07-06','EUR',20,1,'room_night','completed','direct','exact',1,'read-prior-2'),
        ('${PROPERTY}',gen_random_uuid(),gen_random_uuid(),'2026-08-10','2026-08-10','USD',10,1,'room_night','confirmed','direct','exact',1,'read-wrong-currency');
      SET session_replication_role=origin;`);
  });
  afterAll(async () => { await read.close(); await pricing.close(); await cleanup(); await admin.end(); });

  it("returns scoped details, decimal summaries, current ledger state, and zero state", async () => {
    await expect(read.expense(OTHER, EXPENSE)).resolves.toBeNull();
    await expect(read.expense(PROPERTY, CORRECTION)).resolves.toMatchObject({ item: { vendor: "Corrected Alpha", reversesExpenseId: "12130000-0000-4000-8000-000000000013" } });
    await expect(read.expense(PROPERTY, MISMATCH)).resolves.toMatchObject({ incompleteEvidence: [{ code: "expense_currency_mismatch", count: 1, amount: { amount: "999.0000", currency: "USD" } }] });
    await expect(read.recurringRule(PROPERTY, RULE)).resolves.toMatchObject({ item: { cadence: "monthly", active: true } });
    await expect(read.categories(PROPERTY)).resolves.toMatchObject({ item: [{ id: CATEGORY }, { id: SECOND_CATEGORY }] });
    const result = await read.expenses(PROPERTY, query({ limit: 10 }));
    expect(result).toMatchObject({ contractVersion: "pms-financials.v1", currency: "EUR", timeZone: "America/Los_Angeles",
      summary: { totalMtd: { value: { amount: "25.0000" }, absoluteChange: { amount: "-75.0000" }, percentChange: "-0.7500" }, perOccupiedNight: { value: { amount: "8.3333" }, absoluteChange: { amount: "-41.6667" }, percentChange: "-0.8333" }, unpaidAmount: { value: { amount: "95.0000" } }, unpaidCount: { value: 3 } },
      categories: [{ category: { id: CATEGORY }, amount: { amount: "15.0000" } }, { category: { id: SECOND_CATEGORY }, amount: { amount: "10.0000" } }],
      incompleteEvidence: [{ code: "expense_currency_mismatch", count: 1, amount: { amount: "999.0000", currency: "USD" } }, { code: "occupancy_currency_mismatch", count: 1 }] });
    expect(result?.page.items.map(({ id }) => id)).toEqual([EXPENSE, RECURRING, SMALL, CORRECTION, "12130000-0000-4000-8000-000000000008"]);
    await expect(read.expenses(OTHER, query({ limit: 10 }))).resolves.toMatchObject({ incompleteEvidence: [{ code: "occupancy_unavailable", count: 1 }] });
    const future = await read.expenses(PROPERTY, query({ from: "2027-01-01", to: "2027-01-31", limit: 10 })); expect(future?.incompleteEvidence.some(({ amount }) => amount?.currency === "GBP")).toBe(false);
    await expect(read.expenses(EMPTY, query({ limit: 10 }))).resolves.toMatchObject({ summary: { totalMtd: { value: { amount: "0.0000" }, percentChange: null } }, categories: [], page: { items: [], nextCursor: null }, incompleteEvidence: [], sourceFreshness: { pmsPricing: expect.any(String), hotelCatalog: expect.any(String) } });
    const localBoundary = createPgFinanceExpenseReadModel({ connectionString: URL, pricing, propertyContext, now: () => new Date("2026-08-01T01:00:00.000Z") });
    await expect(localBoundary.expenses(PROPERTY, query({ limit: 10 }))).resolves.toMatchObject({ summary: { totalMtd: { value: { amount: "100.0000" } } } }); await localBoundary.close();
  });

  it("composes every filter and keeps versioned cursors bound to the query", async () => {
    const defaultFirst = await read.expenses(PROPERTY, query());
    expect(defaultFirst?.page.items.map(({ id }) => id)).toEqual([EXPENSE, RECURRING]);
    await expect(read.expenses(PROPERTY, { ...query(), cursor: defaultFirst!.page.nextCursor! })).resolves.toMatchObject({ page: { items: [{ id: SMALL }, { id: CORRECTION }] } });
    const filtered = query({ categoryId: CATEGORY, paymentStatus: "unpaid", recurring: false, origin: "manual", search: "Alpha", sort: "amount_desc", limit: 2 });
    const first = await read.expenses(PROPERTY, filtered);
    expect(first?.page.items.map(({ id }) => id)).toEqual([CORRECTION, EXPENSE]);
    expect(first?.page.nextCursor).toEqual(expect.any(String));
    const second = await read.expenses(PROPERTY, { ...filtered, cursor: first!.page.nextCursor! });
    expect(second?.page.items.map(({ id }) => id)).toEqual([SMALL]);
    await expect(read.expenses(PROPERTY, { ...filtered, search: "Changed", cursor: first!.page.nextCursor! })).rejects.toBeInstanceOf(FinanceExpenseCursorError);
    const versionTwo = Buffer.from(JSON.stringify({ v: 2, q: [], p: [] })).toString("base64url");
    await expect(read.expenses(PROPERTY, { ...filtered, cursor: versionTwo })).rejects.toBeInstanceOf(FinanceExpenseCursorError);
    const invalid = JSON.parse(Buffer.from(first!.page.nextCursor!, "base64url").toString("utf8")); invalid.p[0] = "0000-01-01";
    await expect(read.expenses(PROPERTY, { ...filtered, cursor: Buffer.from(JSON.stringify(invalid)).toString("base64url") })).rejects.toBeInstanceOf(FinanceExpenseCursorError);
    invalid.p[0] = "2026-08-08"; invalid.p[1] = "not-a-uuid";
    await expect(read.expenses(PROPERTY, { ...filtered, cursor: Buffer.from(JSON.stringify(invalid)).toString("base64url") })).rejects.toBeInstanceOf(FinanceExpenseCursorError);
    await expect(read.expenses(PROPERTY, { ...filtered, cursor: Buffer.from("{").toString("base64url") })).rejects.toBeInstanceOf(FinanceExpenseCursorError);
  });

  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM booking.nightly_revenue_evidence WHERE property_id IN ('${PROPERTY}','${EMPTY}','${OTHER}');
      DELETE FROM finance.expenses WHERE property_id IN ('${PROPERTY}','${EMPTY}','${OTHER}'); DELETE FROM finance.recurring_expense_rules WHERE property_id IN ('${PROPERTY}','${EMPTY}','${OTHER}');
      DELETE FROM finance.expense_categories WHERE property_id IN ('${PROPERTY}','${EMPTY}','${OTHER}'); DELETE FROM pms.property_pricing_settings WHERE property_id IN ('${PROPERTY}','${EMPTY}','${OTHER}');
      DELETE FROM hotel_catalog.property_locations WHERE property_id IN ('${PROPERTY}','${EMPTY}','${OTHER}'); DELETE FROM hotel_catalog.properties WHERE id IN ('${PROPERTY}','${EMPTY}','${OTHER}'); COMMIT`);
  }
});

function query(patch: Partial<FinanceExpenseQuery> = {}): FinanceExpenseQuery {
  return { from: "2026-07-01", to: "2026-08-11", limit: 2, sort: "incurredOn_desc", ...patch };
}
