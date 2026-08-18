import type { FinanceManualBookingSettlementPort } from "./financeManualBookingSettlement.js";
import type {
  PmsManualBookingCreateCommand,
  PmsManualBookingCreatePort,
  PmsManualBookingCreateResult,
  PmsManualBookingMoney,
} from "@vayada/domain-pms";
import type { QueryResult, QueryResultRow } from "pg";

import type { ManualBookingPreviewResult } from "../routes/pmsManualBookingPreview.js";
import type { PmsManualBookingPreviewRoutesOptions } from "../routes/pmsManualBookingPreviewCalculation.js";
import type { PmsRoomAssignmentOptimizationTriggerPort } from "./pmsRoomAssignmentOptimizationTriggers.js";

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
export type PmsManualBookingAttribution = Readonly<{
  bookingChannel: "direct";
  directSource: PmsManualBookingCreateCommand["directSource"];
}>;

export type PmsManualBookingCommandReservation = Readonly<{
  id: string;
  keyHash: string;
  requestFingerprint: string;
}>;

export interface PmsManualBookingBookingOwnerPort {
  assertSourceCommandUnused(input: {
    transaction: PmsManualBookingTransaction;
    commandId: string;
  }): Promise<void>;
  persistBookingFacts(input: {
    transaction: PmsManualBookingTransaction;
    command: PmsManualBookingCreateCommand;
    preview: ManualBookingPreviewResult;
    guestBookingId: string;
    bookingReference: string;
    attribution: PmsManualBookingAttribution;
  }): Promise<PmsManualBookingAcceptedWrite>;
  markPaid(input: {
    transaction: PmsManualBookingTransaction;
    guestBookingId: string;
  }): Promise<void>;
}

export interface PmsManualBookingOperationsOwnerPort {
  lockRooms(input: {
    transaction: PmsManualBookingTransaction;
    command: PmsManualBookingCreateCommand;
  }): Promise<readonly PmsManualBookingRoom[]>;
  persistOperationalFacts(input: {
    transaction: PmsManualBookingTransaction;
    command: PmsManualBookingCreateCommand;
    rooms: readonly PmsManualBookingRoom[];
    guestBookingId: string;
  }): Promise<void>;
}

export interface PmsManualBookingPlatformOwnerPort {
  findReplay(input: {
    transaction: PmsManualBookingTransaction;
    command: PmsManualBookingCreateCommand;
  }): Promise<PmsManualBookingCreateResult | null>;
  reserveCommand(input: {
    transaction: PmsManualBookingTransaction;
    command: PmsManualBookingCreateCommand;
  }): Promise<PmsManualBookingCommandReservation | null>;
  writeEvidence(input: {
    transaction: PmsManualBookingTransaction;
    command: PmsManualBookingCreateCommand;
    preview: ManualBookingPreviewResult;
    result: PmsManualBookingCreateResult;
    reservation: PmsManualBookingCommandReservation;
  }): Promise<void>;
  completeCommand(input: {
    transaction: PmsManualBookingTransaction;
    reservation: PmsManualBookingCommandReservation;
    result: PmsManualBookingCreateResult;
    completedAt: string;
  }): Promise<void>;
}

/** VAY-1184 implements this Booking-owned boundary. */
export interface PmsManualBookingNightlyEvidenceOwnerPort {
  appendExactNightlyEvidence(input: {
    transaction: PmsManualBookingTransaction;
    command: PmsManualBookingCreateCommand;
    guestBookingId: string;
    rooms: readonly PmsManualBookingRoom[];
    preview: ManualBookingPreviewResult;
  }): Promise<void>;
}

export interface PmsManualBookingAttributionOwnerPort {
  resolveManualAttribution(input: { directSource: unknown }): PmsManualBookingAttribution;
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
  booking: PmsManualBookingBookingOwnerPort;
  operations: PmsManualBookingOperationsOwnerPort;
  platform: PmsManualBookingPlatformOwnerPort;
  nightlyEvidence: PmsManualBookingNightlyEvidenceOwnerPort;
  attribution: PmsManualBookingAttributionOwnerPort;
  financeSettlement: FinanceManualBookingSettlementPort;
  pricing: PmsManualBookingTransactionalPricingPort;
  roomAssignmentOptimization: PmsRoomAssignmentOptimizationTriggerPort;
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
