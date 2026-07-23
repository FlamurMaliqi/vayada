import type { QueryResult, QueryResultRow } from "pg";

export type InventoryReservationTransaction = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export type InventoryReservationReceipt = Record<string, unknown>;

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
    bookingMetadata: unknown;
    occurredAt: Date;
  }): Promise<void>;
};
