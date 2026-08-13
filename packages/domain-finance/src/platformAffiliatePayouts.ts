import type { FinanceCommandAudit, FinanceCommandMeta } from "./index.js";

export const FINANCE_PLATFORM_AFFILIATE_PAYOUT_CONTRACT_VERSION =
  "finance-platform-affiliate-payouts.v1" as const;

export const FINANCE_AFFILIATE_PAYOUT_MANUAL_METHODS = ["manual", "bank_transfer"] as const;

export type FinanceAffiliatePayoutManualMethod =
  (typeof FINANCE_AFFILIATE_PAYOUT_MANUAL_METHODS)[number];

export type FinancePlatformAffiliatePayoutSummary = {
  affiliateId: string;
  organizationId: string;
  affiliateLifecycleStatus: "active" | "inactive";
  currency: string;
  payoutMethod: string;
  outstandingAmount: string;
  payableAmount: string;
  paidAmount: string;
  payoutCount: number;
  payableCount: number;
  lastPaidAt: string | null;
};

export type FinanceAffiliatePayoutPaymentEvidence = {
  evidenceId: string;
  affiliateId: string;
  organizationId: string;
  payoutIds: string[];
  amount: string;
  currency: string;
  paymentMethod: FinanceAffiliatePayoutManualMethod;
  externalReference: string;
  evidenceReference: string;
  note: string | null;
  paidAt: string;
  recordedAt: string;
};

export type FinancePlatformAffiliatePayoutLine = {
  payoutId: string;
  relatedPropertyId: string | null;
  guestBookingId: string | null;
  payoutStatus:
    | "pending"
    | "scheduled"
    | "processing"
    | "paid"
    | "failed"
    | "canceled"
    | "reversed";
  amount: string;
  feeAmount: string;
  netAmount: string;
  currency: string;
  payoutMethod: string;
  providerPayoutId: string | null;
  scheduledAt: string | null;
  paidAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  retryCount: number;
  manualMarkPaidEligible: boolean;
  paymentEvidenceId: string | null;
};

export type FinancePlatformAffiliatePayoutListResponse = {
  contractVersion: typeof FINANCE_PLATFORM_AFFILIATE_PAYOUT_CONTRACT_VERSION;
  summaries: FinancePlatformAffiliatePayoutSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type FinancePlatformAffiliatePayoutDetailResponse = {
  contractVersion: typeof FINANCE_PLATFORM_AFFILIATE_PAYOUT_CONTRACT_VERSION;
  summary: FinancePlatformAffiliatePayoutSummary;
  payouts: FinancePlatformAffiliatePayoutLine[];
  history: FinanceAffiliatePayoutPaymentEvidence[];
};

export type FinancePlatformAffiliatePayoutListQuery = { limit: number; offset: number };

export type FinanceAffiliatePayoutMarkPaidPayload = {
  payoutIds: string[];
  expectedAmount: string;
  paymentMethod: FinanceAffiliatePayoutManualMethod;
  externalReference: string;
  evidenceReference: string;
  paidAt: string;
  note?: string | null;
};

export type FinanceAffiliatePayoutMarkPaidCommand = {
  commandType: "finance.affiliate_payout.mark_paid";
  commandId: string;
  idempotencyKey: string;
  affiliateId: string;
  currency: string;
  audit: FinanceCommandAudit;
  payload: FinanceAffiliatePayoutMarkPaidPayload;
};

export type FinanceAffiliatePayoutMarkPaidResult =
  | {
      ok: true;
      status: "updated" | "idempotent_replay";
      evidence: FinanceAffiliatePayoutPaymentEvidence;
      commandMeta: FinanceCommandMeta;
    }
  | {
      ok: false;
      statusCode: 400 | 404 | 409 | 500;
      code:
        | "invalid_command"
        | "affiliate_not_found"
        | "payout_not_found"
        | "invalid_status_transition"
        | "stale_payout_snapshot"
        | "duplicate_reference"
        | "idempotency_conflict"
        | "write_unavailable";
      message: string;
    };

export type FinancePlatformAffiliatePayoutRepository = {
  listPlatformAffiliatePayoutSummaries(
    query: FinancePlatformAffiliatePayoutListQuery,
  ): Promise<Omit<FinancePlatformAffiliatePayoutListResponse, "contractVersion">>;
  getPlatformAffiliatePayoutDetail(
    affiliateId: string,
    currency: string,
  ): Promise<Omit<FinancePlatformAffiliatePayoutDetailResponse, "contractVersion"> | null>;
  markAffiliatePayoutPaid(
    command: FinanceAffiliatePayoutMarkPaidCommand,
  ): Promise<FinanceAffiliatePayoutMarkPaidResult>;
};

export type NormalizedFinanceAffiliatePayoutMarkPaid = Omit<
  FinanceAffiliatePayoutMarkPaidCommand,
  "audit" | "payload"
> & {
  audit: Omit<FinanceCommandAudit, "actor"> & {
    actor: Extract<FinanceCommandAudit["actor"], { kind: "user" }>;
  };
  payload: Required<Omit<FinanceAffiliatePayoutMarkPaidPayload, "note">> & {
    note: string | null;
  };
};

export class FinanceAffiliatePayoutMarkPaidError extends Error {
  constructor(readonly code: "invalid_command") {
    super(code);
    this.name = "FinanceAffiliatePayoutMarkPaidError";
  }
}

export function normalizeFinanceAffiliatePayoutMarkPaid(
  value: unknown,
): NormalizedFinanceAffiliatePayoutMarkPaid {
  if (
    !record(value, [
      "commandType",
      "commandId",
      "idempotencyKey",
      "affiliateId",
      "currency",
      "audit",
      "payload",
    ])
  )
    invalid();
  if (value.commandType !== "finance.affiliate_payout.mark_paid") invalid();
  if (!record(value.audit, ["actor", "requestId", "reason", "requestedAt"], ["correlationId"]))
    invalid();
  if (!record(value.audit.actor, ["kind", "userId", "organizationId"])) invalid();
  if (value.audit.actor.kind !== "user") invalid();
  if (
    !record(
      value.payload,
      [
        "payoutIds",
        "expectedAmount",
        "paymentMethod",
        "externalReference",
        "evidenceReference",
        "paidAt",
      ],
      ["note"],
    )
  )
    invalid();

  return {
    commandType: value.commandType,
    commandId: text(value.commandId, 200),
    idempotencyKey: text(value.idempotencyKey, 200),
    affiliateId: text(value.affiliateId, 200),
    currency: currency(value.currency),
    audit: {
      actor: {
        kind: "user",
        userId: uuid(value.audit.actor.userId),
        organizationId: uuid(value.audit.actor.organizationId),
      },
      requestId: text(value.audit.requestId, 200),
      correlationId: optionalText(value.audit.correlationId, 200) ?? undefined,
      reason: text(value.audit.reason, 500),
      requestedAt: instant(value.audit.requestedAt),
    },
    payload: {
      payoutIds: payoutIds(value.payload.payoutIds),
      expectedAmount: money(value.payload.expectedAmount),
      paymentMethod: manualMethod(value.payload.paymentMethod),
      externalReference: text(value.payload.externalReference, 200),
      evidenceReference: text(value.payload.evidenceReference, 500),
      paidAt: instant(value.payload.paidAt),
      note: optionalText(value.payload.note, 1000),
    },
  };
}

function record(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || value !== value.trim())
    invalid();
  return value;
}

function optionalText(value: unknown, maximum: number): string | null {
  return value == null ? null : text(value, maximum);
}

function currency(value: unknown): string {
  const result = text(value, 3);
  if (!/^[A-Z]{3}$/.test(result)) invalid();
  return result;
}

function payoutIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) invalid();
  const result = value.map(uuid);
  if (new Set(result).size !== result.length) invalid();
  return result.sort();
}

function money(value: unknown): string {
  const result = text(value, 18);
  if (!/^(?:0|[1-9]\d{0,12})\.\d{2}$/.test(result) || result === "0.00") invalid();
  return result;
}

function manualMethod(value: unknown): FinanceAffiliatePayoutManualMethod {
  if (!FINANCE_AFFILIATE_PAYOUT_MANUAL_METHODS.some((method) => method === value)) invalid();
  return value as FinanceAffiliatePayoutManualMethod;
}

function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result))
    invalid();
  return result.toLowerCase();
}

function instant(value: unknown): string {
  const result = text(value, 40);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      result,
    );
  if (!match) invalid();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) invalid();
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) invalid();
  const timestamp = Date.parse(result);
  if (!Number.isFinite(timestamp)) invalid();
  const normalized = new Date(timestamp).toISOString();
  if (normalized.startsWith("0000-")) invalid();
  return normalized;
}

function invalid(): never {
  throw new FinanceAffiliatePayoutMarkPaidError("invalid_command");
}
