import { getTimezone } from "countries-and-timezones";

import {
  appendExternalNightlyRevenueEvidence,
  type ExternalRevenueEvidenceClient,
  type ExternalRevenueEvidenceLine,
} from "./bookingExternalNightlyRevenueEvidence.js";

type Money = { amountDecimal: string; currency: string };
export type ManualPriceCorrectionPricing =
  | {
      kind: "exact";
      nights: readonly { targetEvidenceId: string; replacementAmount: Money }[];
    }
  | {
      kind: "equal_inferred";
      targetEvidenceIds: readonly string[];
      replacementTotal: Money;
    };
type Command = {
  propertyId: string;
  guestBookingId: string;
  idempotencyKey: string;
  accountingDate: string;
  pricing: ManualPriceCorrectionPricing;
};
type BookingScope = {
  sourceBookingReference: string;
  currency: string;
  lifecycleStatus: string;
  timezone: string | null;
};
type CurrentTip = {
  id: string;
  roomTypeId: string;
  stayDate: string;
  recognizedOn: string;
  amount: string | null;
  occupied: number;
  linePosition: number;
  manual: boolean;
};
type Replacement = CurrentTip & {
  replacement: string;
  evidenceQuality: "exact" | "inferred";
};

export class ManualPriceCorrectionEvidenceError extends Error {}
export class ManualPriceCorrectionStateError extends Error {
  constructor(
    message: string,
    readonly currentStatus: string,
  ) {
    super(message);
  }
}

export async function correctBookingPmsManualPrices(
  transaction: ExternalRevenueEvidenceClient,
  command: Command,
  acceptedAt: string,
): Promise<void> {
  if (!validDate(command.accountingDate) || !Number.isFinite(Date.parse(acceptedAt)))
    throw new ManualPriceCorrectionEvidenceError("Manual price correction dates are invalid");
  const booking = await transaction.query<BookingScope>(
    `SELECT source_booking_id AS "sourceBookingReference",trim(currency) AS currency,
       lifecycle_status AS "lifecycleStatus",
       (SELECT timezone FROM hotel_catalog.property_locations
        WHERE property_id=booking.property_id) AS timezone
     FROM booking.guest_bookings booking WHERE id=$1::uuid AND property_id=$2::uuid
       AND source_system='pms' AND booking_metadata->>'contractVersion'='pms-manual-booking.v1'
     FOR UPDATE`,
    [command.guestBookingId, command.propertyId],
  );
  const scope = booking.rows[0];
  if (!scope || scope.lifecycleStatus !== "confirmed")
    throw new ManualPriceCorrectionStateError(
      "Manual booking prices cannot be corrected",
      scope?.lifecycleStatus ?? "missing",
    );
  const refunded = await transaction.query(
    `SELECT 1 FROM booking.nightly_revenue_evidence
     WHERE guest_booking_id=$1::uuid AND economic_event='refund' LIMIT 1`,
    [command.guestBookingId],
  );
  if (refunded.rowCount)
    throw new ManualPriceCorrectionEvidenceError(
      "Manual booking prices cannot be corrected after a refund",
    );
  const zone = scope.timezone && getTimezone(scope.timezone);
  if (!zone || zone.name !== scope.timezone || zone.aliasOf !== null)
    throw new ManualPriceCorrectionEvidenceError(
      "Manual price correction requires a canonical property timezone",
    );
  if (command.accountingDate < propertyDate(acceptedAt, scope.timezone!))
    throw new ManualPriceCorrectionEvidenceError(
      "Manual price correction accounting date is invalid",
    );

  const tips = await loadCurrentTips(transaction, command);
  const replacements = resolveReplacements(command.pricing, tips, scope.currency);
  if (
    replacements.some(
      ({ occupied, manual, recognizedOn }) =>
        occupied !== 1 || !manual || command.accountingDate < recognizedOn,
    )
  )
    throw new ManualPriceCorrectionEvidenceError("Manual price correction targets are unavailable");
  const lines = replacements.flatMap<ExternalRevenueEvidenceLine>((tip) => {
    const delta = units(tip.replacement) - (tip.amount === null ? 0n : units(tip.amount));
    return delta === 0n && tip.amount !== null
      ? []
      : [
          {
            roomTypeId: tip.roomTypeId,
            stayDate: tip.stayDate,
            recognizedOn: command.accountingDate,
            grossRoomAmount: amount(delta),
            occupiedRoomNights: 0,
            economicEvent: "correction",
            lifecycleState: "corrected",
            evidenceQuality: tip.evidenceQuality,
            linePosition: tip.linePosition,
            correctsEvidenceId: tip.id,
          },
        ];
  });
  if (lines.length === 0)
    throw new ManualPriceCorrectionEvidenceError("Manual price correction has no price change");
  await appendExternalNightlyRevenueEvidence(transaction, {
    propertyId: command.propertyId,
    guestBookingId: command.guestBookingId,
    sourceKind: "manual",
    sourceBookingReference: scope.sourceBookingReference,
    idempotencyKey: `pms-price-correction:${command.idempotencyKey}:v1`,
    lines,
  });
}

async function loadCurrentTips(
  transaction: ExternalRevenueEvidenceClient,
  command: Pick<Command, "propertyId" | "guestBookingId">,
): Promise<CurrentTip[]> {
  const result = await transaction.query<CurrentTip>(
    `WITH state AS (SELECT id,room_type_id,stay_date,recognized_on,line_position,
       source_kind,source_revision,created_at,(SUM(occupied_room_nights) OVER scope)::int occupied,
       SUM(gross_room_amount) OVER scope AS amount,
       row_number() OVER (scope ORDER BY source_revision DESC,created_at DESC,id DESC) AS tip
     FROM booking.nightly_revenue_evidence WHERE property_id=$1::uuid
       AND guest_booking_id=$2::uuid AND economic_event<>'retained_charge'
     WINDOW scope AS (PARTITION BY stay_date,line_position))
     SELECT id::text,room_type_id::text AS "roomTypeId",stay_date::text AS "stayDate",
       recognized_on::text AS "recognizedOn",amount::text,occupied,
       line_position AS "linePosition",source_kind='manual' AS manual
     FROM state WHERE tip=1 ORDER BY stay_date,line_position,id`,
    [command.propertyId, command.guestBookingId],
  );
  return result.rows.map((tip) => ({ ...tip, amount: normalizeStored(tip.amount) }));
}

function resolveReplacements(
  pricing: ManualPriceCorrectionPricing,
  tips: readonly CurrentTip[],
  currency: string,
): Replacement[] {
  const byId = new Map(tips.map((tip) => [tip.id, tip]));
  if (pricing.kind === "exact") {
    const ids = pricing.nights.map(({ targetEvidenceId }) => targetEvidenceId);
    if (!validTargets(ids, byId)) throw unavailable();
    return pricing.nights.map(({ targetEvidenceId, replacementAmount }) => ({
      ...byId.get(targetEvidenceId)!,
      replacement: normalizeMoney(replacementAmount, currency),
      evidenceQuality: "exact",
    }));
  }
  if (!validTargets(pricing.targetEvidenceIds, byId)) throw unavailable();
  const total = units(normalizeMoney(pricing.replacementTotal, currency));
  const selected = pricing.targetEvidenceIds.map((id) => byId.get(id)!).sort(compareTips);
  const quotient = total / BigInt(selected.length),
    remainder = total % BigInt(selected.length);
  return selected.map((tip, index) => ({
    ...tip,
    replacement: amount(quotient + (BigInt(index) < remainder ? 1n : 0n)),
    evidenceQuality: "inferred",
  }));
}

function validTargets(ids: readonly string[], tips: ReadonlyMap<string, CurrentTip>): boolean {
  return ids.length > 0 && ids.length <= 20 * 366 && new Set(ids).size === ids.length
    ? ids.every((id) => tips.has(id))
    : false;
}
function normalizeMoney(value: Money, currency: string): string {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.currency !== "string" ||
    typeof value.amountDecimal !== "string" ||
    value.currency !== currency ||
    !/^(0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(value.amountDecimal)
  )
    throw new ManualPriceCorrectionEvidenceError("Manual price correction amount is invalid");
  const [whole, fraction = ""] = value.amountDecimal.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}`;
}
function normalizeStored(value: string | null): string | null {
  if (value === null) return null;
  const negative = value.startsWith("-");
  const normalized = normalizeMoney(
    { amountDecimal: negative ? value.slice(1) : value, currency: "EUR" },
    "EUR",
  );
  return negative && normalized !== "0.0000" ? `-${normalized}` : normalized;
}
const compareTips = (left: CurrentTip, right: CurrentTip) =>
  left.stayDate.localeCompare(right.stayDate) ||
  left.linePosition - right.linePosition ||
  left.id.localeCompare(right.id);
const unavailable = () =>
  new ManualPriceCorrectionEvidenceError("Manual price correction targets are unavailable");
const units = (value: string) => BigInt(value.replace(".", ""));
function amount(value: bigint): string {
  const negative = value < 0n,
    absolute = negative ? -value : value,
    digits = absolute.toString().padStart(5, "0");
  const normalized = `${digits.slice(0, -4)}.${digits.slice(-4)}`;
  return negative && absolute !== 0n ? `-${normalized}` : normalized;
}
function propertyDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values["year"]}-${values["month"]}-${values["day"]}`;
}
const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !value.startsWith("0000-") &&
  new Date(value).toJSON() === `${value}T00:00:00.000Z`;
