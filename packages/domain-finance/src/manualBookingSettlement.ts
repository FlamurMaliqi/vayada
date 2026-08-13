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
  value: unknown,
): NormalizedFinanceManualBookingSettlement {
  if (
    !record(value, ["commandType", "commandId", "idempotencyKey", "propertyId", "audit", "payload"])
  )
    invalid();
  const command = value;
  if (!record(command.audit, ["actor", "requestId", "reason", "requestedAt"], ["correlationId"]))
    invalid();
  const audit = command.audit;
  if (!record(audit.actor, ["kind", "userId", "organizationId"])) invalid();
  const actorInput = audit.actor;
  if (
    !record(
      command.payload,
      ["booking", "amount", "currency", "paymentMethod", "sourceReference", "acceptedAt"],
      ["operatorReference"],
    )
  )
    invalid();
  const payload = command.payload;
  if (!record(payload.booking, ["guestBookingId"])) invalid();
  const booking = payload.booking;
  if (command.commandType !== "finance.manual_booking.settle_full") invalid();
  const propertyId = uuid(command.propertyId);
  const currency = currencyCode(payload.currency);
  const amount = money(payload.amount);
  if (actorInput.kind !== "user") invalid();
  const actor = {
    kind: "user" as const,
    userId: uuid(actorInput.userId),
    organizationId: uuid(actorInput.organizationId),
  };

  return {
    commandId: text(command.commandId, 200),
    idempotencyKey: text(command.idempotencyKey, 200),
    propertyId,
    guestBookingId: uuid(booking.guestBookingId),
    amount,
    currency,
    paymentMethod: paymentMethod(payload.paymentMethod),
    sourceReference: text(payload.sourceReference, 200),
    operatorReference: optionalText(payload.operatorReference, 500),
    acceptedAt: instant(payload.acceptedAt),
    audit: {
      actor,
      requestId: text(audit.requestId, 200),
      correlationId: optionalText(audit.correlationId, 200),
      reason: text(audit.reason, 500),
      requestedAt: instant(audit.requestedAt),
    },
  };
}

function money(value: unknown): FinanceDecimalAmount {
  if (typeof value !== "string") invalid();
  const match = /^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) invalid();
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
}

function currencyCode(value: unknown): FinanceCurrencyCode {
  if (typeof value !== "string") invalid();
  if (!/^[A-Z]{3}$/.test(value)) invalid();
  return value;
}

function paymentMethod(value: unknown): FinanceManualBookingPaymentMethod {
  if (typeof value !== "string") invalid();
  if (!FINANCE_MANUAL_BOOKING_PAYMENT_METHODS.some((method) => method === value)) invalid();
  return value as FinanceManualBookingPaymentMethod;
}

function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    invalid();
  }
  return value.toLowerCase();
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || value !== value.trim())
    invalid();
  return value;
}

function optionalText(value: unknown, maximum: number): string | null {
  if (value == null) return null;
  return text(value, maximum);
}

function instant(value: unknown): string {
  if (typeof value !== "string") invalid();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match) {
    invalid();
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) invalid();
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) invalid();
  const parsed = new Date(value);
  if (!value.trim() || Number.isNaN(parsed.valueOf())) invalid();
  const normalized = parsed.toISOString();
  if (normalized.startsWith("0000-")) invalid();
  return normalized;
}

function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function invalid(): never {
  throw new FinanceManualBookingSettlementError("invalid_command");
}
