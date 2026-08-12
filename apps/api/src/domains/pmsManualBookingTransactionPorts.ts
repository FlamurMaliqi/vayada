import type { FinanceManualBookingSettlementPort } from "./financeManualBookingSettlement.js";
import type {
  PmsManualBookingCreateCommand,
  PmsManualBookingCreatePort,
  PmsManualBookingMoney,
} from "@vayada/domain-pms";
import type { QueryResult, QueryResultRow } from "pg";

import type { ManualBookingPreviewResult } from "../routes/pmsManualBookingPreview.js";
import type { PmsManualBookingPreviewRoutesOptions } from "../routes/pmsManualBookingPreviewCalculation.js";

export type PmsManualBookingTransaction = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
};

export type PmsManualBookingTransactionClient = PmsManualBookingTransaction & {
  release(): void;
};

export type PmsManualBookingTransactionPool = {
  connect(): Promise<PmsManualBookingTransactionClient>;
  end?(): Promise<void>;
};

export type PmsManualBookingRoom = Readonly<{ roomId: string; roomTypeId: string }>;

/** VAY-1184 implements this Booking-owned boundary. */
export interface PmsManualBookingNightlyEvidenceOwnerPort {
  appendExactNightlyEvidence(input: {
    transaction: PmsManualBookingTransaction;
    command: PmsManualBookingCreateCommand;
    guestBookingId: string;
    bookingReference: string;
    rooms: readonly PmsManualBookingRoom[];
    preview: ManualBookingPreviewResult;
  }): Promise<void>;
}

/** VAY-1187 implements this Booking-owned boundary after Email lands in VAY-1186. */
export interface PmsManualBookingAttributionOwnerPort {
  recordManualAttribution(input: {
    transaction: PmsManualBookingTransaction;
    propertyId: string;
    guestBookingId: string;
    bookingChannel: "direct";
    directSource: PmsManualBookingCreateCommand["directSource"];
  }): Promise<void>;
}

export interface PmsManualBookingTransactionalPricingPort {
  calculate(input: {
    transaction: PmsManualBookingTransaction;
    command: PmsManualBookingCreateCommand;
    acceptedAt: Date;
  }): Promise<ManualBookingPreviewResult>;
}

export type PmsManualBookingCurrentPricingEvidence = {
  getPricingSourceSnapshot(input: {
    transaction: PmsManualBookingTransaction;
    propertyId: string;
  }): ReturnType<PmsManualBookingPreviewRoutesOptions["pricing"]["getPricingSourceSnapshot"]>;
  getRoomPublicationSnapshot(input: {
    transaction: PmsManualBookingTransaction;
    propertyId: string;
    organizationId: string;
  }): ReturnType<
    PmsManualBookingPreviewRoutesOptions["roomPublication"]["getRoomPublicationSnapshot"]
  >;
};

export type PmsManualBookingTransactionDependencies = Readonly<{
  nightlyEvidence: PmsManualBookingNightlyEvidenceOwnerPort;
  attribution: PmsManualBookingAttributionOwnerPort;
  financeSettlement: FinanceManualBookingSettlementPort;
  pricing: PmsManualBookingTransactionalPricingPort;
}>;

export type PmsManualBookingAcceptedWrite = Readonly<{
  guestBookingId: string;
  bookingReference: string;
  total: PmsManualBookingMoney;
  checkIn: string;
  checkOut: string;
}>;

export type PmsManualBookingCommandRepository = PmsManualBookingCreatePort & {
  close(): Promise<void>;
};
