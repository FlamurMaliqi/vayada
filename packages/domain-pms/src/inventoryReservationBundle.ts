import {
  parsePmsInventoryReservationReceipt,
  type PmsInventoryReservationReceipt,
} from "./inventoryReservationLifecycle.js";

export const PMS_INVENTORY_RESERVATION_BUNDLE_VERSION = "pms-inventory-reservation-bundle.v1";
export type PmsInventoryReservationBundle = Readonly<{
  contractVersion: typeof PMS_INVENTORY_RESERVATION_BUNDLE_VERSION;
  owner: "pms";
  /** PMS binds each opaque receipt to its persisted property/room/stay. */
  receipts: readonly PmsInventoryReservationReceipt[];
}>;

export function parsePmsInventoryReservationBundle(
  value: unknown,
): PmsInventoryReservationBundle | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    input.contractVersion !== PMS_INVENTORY_RESERVATION_BUNDLE_VERSION ||
    input.owner !== "pms" ||
    !Array.isArray(input.receipts) ||
    input.receipts.length < 1 ||
    input.receipts.length > 99
  )
    return null;
  const receipts: PmsInventoryReservationReceipt[] = [];
  const ids = new Set<string>();
  for (const value of input.receipts) {
    const receipt = parsePmsInventoryReservationReceipt(value);
    if (!receipt || ids.has(receipt.receiptId.toLowerCase())) return null;
    ids.add(receipt.receiptId.toLowerCase());
    receipts.push(receipt);
  }
  return { contractVersion: PMS_INVENTORY_RESERVATION_BUNDLE_VERSION, owner: "pms", receipts };
}
