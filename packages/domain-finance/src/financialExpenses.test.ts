import { describe, expect, it } from "vitest";

import {
  FINANCE_EXPENSE_ORIGINS,
  normalizeFinanceExpenseAmount,
  parseFinanceExpenseQuery,
  parseFinanceExpenseWrite,
} from "./financialExpenses.js";

const COMMAND = {
  commandId: "10000000-0000-4000-8000-000000000001",
  idempotencyKey: "expense-command-1",
};
const CATEGORY_ID = "20000000-0000-4000-8000-000000000001";

describe("Financials expense contract", () => {
  it("uses the accepted contract and complete origin vocabulary", () => {
    expect(FINANCE_EXPENSE_ORIGINS.join(",")).toBe(
      "manual,recurring,ota_commission,platform_fee,supplier_bill",
    );
  });

  it.each([
    ["999999999999999.9999", "999999999999999.9999"],
    ["0", null],
    ["1.00000", null],
    ["1000000000000000", null],
  ])("normalizes positive NUMERIC(19,4) amounts (%s)", (value, expected) => {
    expect(normalizeFinanceExpenseAmount(value)).toBe(expected);
  });

  it("parses normalized query defaults and documented filters", () => {
    expect(
      parseFinanceExpenseQuery({
        from: "2026-08-01",
        to: "2026-08-31",
        categoryId: CATEGORY_ID,
        paymentStatus: "unpaid",
        limit: "50",
        recurring: "true",
        origin: "recurring",
        search: "Electricity",
        sort: "amount_desc",
      }),
    ).toMatchObject({ limit: 50, sort: "amount_desc", origin: "recurring", recurring: true });
  });

  it.each([
    { from: "2026-08-31", to: "2026-08-01" },
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "0000-01-01", to: "2026-03-01" },
    { from: "2026-08-01", to: "2026-08-31", limit: 201 },
    { from: "2026-08-01", to: "2026-08-31", cursor: "A" },
    { from: "2026-08-01", to: "2026-08-31", cursor: "not a cursor!" },
    { from: "2026-08-01", to: "2026-08-31", recurring: "yes" },
    { from: "2026-08-01", to: "2026-08-31", surprise: true },
  ])("rejects an invalid or ambiguous query", (query) => {
    expect(parseFinanceExpenseQuery(query)).toBeNull();
  });

  it("parses paid recurring manual expense input without floats", () => {
    const parsed = parseFinanceExpenseWrite({
      ...COMMAND,
      incurredOn: "2026-08-08",
      vendor: "Utility Co",
      categoryId: CATEGORY_ID,
      amount: { amount: "125.5", currency: "EUR" },
      paymentStatus: "paid",
      paidOn: "2026-08-09",
      recurrence: { cadence: "monthly", startsOn: "2026-08-08" },
    });
    expect(parsed?.amount).toEqual({ amount: "125.5000", currency: "EUR" });
    expect(parsed?.recurrence?.cadence).toBe("monthly");
    // prettier-ignore
    expect(parseFinanceExpenseWrite({ ...COMMAND, incurredOn: "2026-08-08", vendor: "Utility Co", categoryId: CATEGORY_ID, amount: { amount: "1", currency: "EUR" }, paymentStatus: "unpaid", paidOn: null })?.paidOn).toBeNull();
  });

  it.each([
    { amount: { amount: "0", currency: "EUR" }, paymentStatus: "unpaid" },
    { amount: { amount: "1", currency: "eur" }, paymentStatus: "unpaid" },
    { amount: { amount: "1", currency: "EUR" }, paymentStatus: "paid" },
  ])("rejects inconsistent expense money or payment state", (change) => {
    expect(
      parseFinanceExpenseWrite({
        ...COMMAND,
        incurredOn: "2026-08-08",
        vendor: "Vendor",
        categoryId: CATEGORY_ID,
        ...change,
      }),
    ).toBeNull();
  });
});
