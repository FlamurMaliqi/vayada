type FinanceCurrencyCode = string;
type FinanceDecimalAmount = string;

export const FINANCE_MANUAL_BOOKING_PAYMENT_METHODS = [
  "pay_at_property",
  "bank_transfer",
  "manual_card",
  "cash",
  "other",
] as const;

export type FinanceManualBookingPaymentMethod =
  (typeof FINANCE_MANUAL_BOOKING_PAYMENT_METHODS)[number];

export type FinanceManualBookingSettlementPayload = {
  booking: {
    guestBookingId: string;
  };
  amount: FinanceDecimalAmount;
  currency: FinanceCurrencyCode;
  paymentMethod: FinanceManualBookingPaymentMethod;
  sourceReference: string;
  operatorReference?: string | null;
  acceptedAt: string;
};

export type FinanceManualBookingSettlementCommand = {
  commandType: "finance.manual_booking.settle_full";
  commandId: string;
  idempotencyKey: string;
  propertyId: string;
  audit: {
    actor: { kind: "user"; userId: string; organizationId: string };
    requestId: string;
    correlationId?: string;
    reason: string;
    requestedAt: string;
  };
  payload: FinanceManualBookingSettlementPayload;
};

export type FinanceManualBookingSettlementReceipt = {
  paymentEvidenceId: string;
  status: "paid";
};

export type FinanceManualBookingSettlementErrorCode =
  | "invalid_command"
  | "cross_property"
  | "cross_currency"
  | "non_full_settlement"
  | "idempotency_conflict";

export class FinanceManualBookingSettlementError extends Error {
  constructor(readonly code: FinanceManualBookingSettlementErrorCode) {
    super(code);
    this.name = "FinanceManualBookingSettlementError";
  }
}

export type NormalizedFinanceManualBookingSettlement = {
  commandId: string;
  idempotencyKey: string;
  propertyId: string;
  guestBookingId: string;
  amount: FinanceDecimalAmount;
  currency: FinanceCurrencyCode;
  paymentMethod: FinanceManualBookingPaymentMethod;
  sourceReference: string;
  operatorReference: string | null;
  acceptedAt: string;
  audit: {
    actor: { kind: "user"; userId: string; organizationId: string };
    requestId: string;
    correlationId: string | null;
    reason: string;
    requestedAt: string;
  };
};

export function normalizeFinanceManualBookingSettlement(
  command: FinanceManualBookingSettlementCommand,
): NormalizedFinanceManualBookingSettlement {
  if (command.commandType !== "finance.manual_booking.settle_full") invalid();
  const propertyId = uuid(command.propertyId);
  const currency = currencyCode(command.payload.currency);
  const amount = money(command.payload.amount);
  const actor = {
    kind: "user" as const,
    userId: uuid(command.audit.actor.userId),
    organizationId: uuid(command.audit.actor.organizationId),
  };

  return {
    commandId: text(command.commandId),
    idempotencyKey: text(command.idempotencyKey),
    propertyId,
    guestBookingId: uuid(command.payload.booking.guestBookingId),
    amount,
    currency,
    paymentMethod: paymentMethod(command.payload.paymentMethod),
    sourceReference: text(command.payload.sourceReference),
    operatorReference: optionalText(command.payload.operatorReference),
    acceptedAt: instant(command.payload.acceptedAt),
    audit: {
      actor,
      requestId: text(command.audit.requestId),
      correlationId: optionalText(command.audit.correlationId),
      reason: text(command.audit.reason),
      requestedAt: instant(command.audit.requestedAt),
    },
  };
}

function money(value: string): FinanceDecimalAmount {
  const match = /^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) invalid();
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
}

function currencyCode(value: string): FinanceCurrencyCode {
  if (!/^[A-Z]{3}$/.test(value)) invalid();
  return value;
}

function paymentMethod(value: string): FinanceManualBookingPaymentMethod {
  if (!FINANCE_MANUAL_BOOKING_PAYMENT_METHODS.some((method) => method === value)) invalid();
  return value as FinanceManualBookingPaymentMethod;
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    invalid();
  }
  return value.toLowerCase();
}

function text(value: string): string {
  const normalized = value.trim();
  if (!normalized) invalid();
  return normalized;
}

function optionalText(value: string | null | undefined): string | null {
  return value == null || !value.trim() ? null : value.trim();
}

function instant(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match) {
    invalid();
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) invalid();
  const parsed = new Date(value);
  if (!value.trim() || Number.isNaN(parsed.valueOf())) invalid();
  return parsed.toISOString();
}

function invalid(): never {
  throw new FinanceManualBookingSettlementError("invalid_command");
}
