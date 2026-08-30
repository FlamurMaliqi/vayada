import { describe, expect, it } from "vitest";

import {
  exactMoney,
  exactRate,
  minorUnits,
  subtractMoney,
  sumMoney,
} from "./productionFinanceValues.js";

describe("production Finance exact values", () => {
  it("keeps monetary arithmetic decimal exact", () => {
    expect(exactMoney("900719925474.09", "amount")).toBe("900719925474.09");
    expect(subtractMoney("100.10", "0.20", "fee")).toBe("99.90");
    expect(exactRate("5.1250", "rate")).toBe("5.125");
  });

  it("rejects precision loss and invalid totals", () => {
    expect(() => exactMoney("1.001", "amount")).toThrow("at most 2 decimals");
    expect(() => exactMoney(null, "amount", "1.001")).toThrow("at most 2 decimals");
    expect(() => minorUnits("1.1.2")).toThrow("at most 2 decimals");
    expect(() => sumMoney(["1.001"])).toThrow("at most 2 decimals");
    expect(() => exactMoney("10000000000000.00", "amount")).toThrow("target precision");
    expect(() => subtractMoney("1.00", "1.01", "fee")).toThrow("exceeds amount");
    expect(() => exactRate("100.0001", "rate")).toThrow("between 0 and 100");
  });
});
