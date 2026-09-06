import { expect, it } from "vitest";
import { PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION } from "./inventoryReservationLifecycle.js";
import {
  PMS_INVENTORY_RESERVATION_BUNDLE_VERSION,
  parsePmsInventoryReservationBundle,
} from "./inventoryReservationBundle.js";

const receipt = {
  contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
  owner: "pms",
  receiptId: "91000000-0000-4000-8000-000000000001",
};
const bundle = {
  contractVersion: PMS_INVENTORY_RESERVATION_BUNDLE_VERSION,
  owner: "pms",
  receipts: [receipt],
};
it("copies opaque receipts without interpreting inventory ownership", () => {
  const parsed = parsePmsInventoryReservationBundle(bundle)!;
  expect(parsed).toEqual(bundle);
  expect(parsed.receipts[0]).not.toBe(receipt);
});
it.each([
  null,
  {},
  receipt,
  { ...bundle, owner: "booking" },
  { ...bundle, receipts: [] },
  { ...bundle, receipts: [receipt, receipt] },
  { ...bundle, receipts: [receipt, {}] },
  { ...bundle, receipts: Array(100).fill(receipt) },
])("fails closed for malformed, incomplete, or repeated receipts", (input) => {
  expect(parsePmsInventoryReservationBundle(input)).toBeNull();
});
