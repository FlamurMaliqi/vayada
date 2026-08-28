import {
  PMS_INVENTORY_RESERVATION_MARKER_VERSION,
  parsePmsInventoryReservationReceipt,
  type PmsInventoryReservationReceipt,
  type PmsInventoryReservationMarker,
} from "@vayada/domain-pms";
import type { QueryResult, QueryResultRow } from "pg";

export type InventoryReservationTransaction = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export type InventoryReservationReceipt =
  | PmsInventoryReservationReceipt
  | PmsInventoryReservationMarker;

export type DirectBookingInventoryReservationPort = {
  reserve(input: {
    transaction: InventoryReservationTransaction;
    propertyId: string;
    quoteSessionId: string;
    roomTypeId: string;
    publicOfferKey: string;
    checkIn: string;
    checkOut: string;
    roomCount: number;
    currency: string;
    occurredAt: Date;
  }): Promise<InventoryReservationReceipt | null>;
  release(input: {
    transaction: InventoryReservationTransaction;
    propertyId: string;
    reservation: InventoryReservationReceipt;
    occurredAt: Date;
  }): Promise<void>;
  availabilityCredit?(input: {
    transaction: InventoryReservationTransaction;
    propertyId: string;
    reservation: PmsInventoryReservationReceipt;
    roomTypeId: string;
    publicOfferKey: string;
    checkIn: string;
    checkOut: string;
    roomCount: number;
  }): Promise<{ checkIn: string; checkOut: string; roomCount: number } | null>;
};

export function inventoryReservationReceiptFromBookingMetadata(
  bookingMetadata: unknown,
  expectedPropertyId: string,
): InventoryReservationReceipt | null {
  const marker = objectValue(objectValue(bookingMetadata)["inventoryReservation"]);
  const receipt = parsePmsInventoryReservationReceipt(marker);
  if (receipt) return receipt;
  if (
    marker["contractVersion"] !== PMS_INVENTORY_RESERVATION_MARKER_VERSION ||
    marker["owner"] !== "pms" ||
    marker["source"] !== "booking_engine"
  ) {
    return null;
  }

  const quoteSessionId = stringValue(marker["quoteSessionId"]);
  const propertyId = stringValue(marker["propertyId"]);
  const roomTypeId = stringValue(marker["roomTypeId"]);
  const publicOfferKey = stringValue(marker["publicOfferKey"]);
  const checkIn = reservationDate(marker["checkIn"]);
  const checkOut = reservationDate(marker["checkOut"]);
  const roomCount = integerValue(marker["roomCount"]);
  if (
    !quoteSessionId ||
    propertyId !== expectedPropertyId ||
    !roomTypeId ||
    !publicOfferKey ||
    !checkIn ||
    !checkOut ||
    checkIn >= checkOut ||
    roomCount < 1
  ) {
    return null;
  }

  return {
    contractVersion: PMS_INVENTORY_RESERVATION_MARKER_VERSION,
    owner: "pms",
    source: "booking_engine",
    quoteSessionId,
    propertyId,
    roomTypeId,
    publicOfferKey,
    checkIn,
    checkOut,
    roomCount,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function reservationDate(value: unknown): string | null {
  const date = stringValue(value);
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    ? date
    : null;
}
