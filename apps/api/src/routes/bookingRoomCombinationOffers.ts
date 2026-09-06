import {
  BOOKING_ROOM_SELECTION_VERSION,
  searchRoomCombinations,
  type RoomCombinationCandidate,
} from "@vayada/domain-booking";
import { readPmsRoomSelectionConflicts } from "../domains/pmsRoomSelectionConflicts.js";
import { quoteTargetRoomSelection } from "./bookingWebMixedQuote.js";
import { moneyToCents, type BookingWebQueryExecutor } from "./bookingWebPublic.js";

type CombinationQuote = Awaited<ReturnType<typeof quoteTargetRoomSelection>>;
type UnavailableReason =
  | "unavailable_data"
  | "stale_data"
  | "unpublished"
  | "sold_out"
  | "stay_restricted"
  | "min_stay_not_met"
  | "max_stay_exceeded"
  | "payment_disabled"
  | "occupancy_unavailable";
type CandidateRow = {
  fresh: boolean;
  public: boolean;
  sellable: boolean;
  minStay: number | null;
  maxStay: number | null;
  restrictionsReady: boolean;
  roomTypeId: string;
  publicOfferKey: string;
  nightCount: number;
  occupancyReady: boolean;
  maxAdults: number;
  maxChildren: number;
  maxOccupancy: number;
  expiresAt: Date | string | null;
};

/** Internal until the complete selection can travel through every public consumer. */
export async function findTargetRoomCombinationOffers(
  pool: BookingWebQueryExecutor,
  input: Omit<Parameters<typeof quoteTargetRoomSelection>[1], "selection" | "credits"> & {
    adults: number;
    children: number;
    paymentMethods: readonly string[];
    maxCandidates?: number;
    maxWork?: number;
  },
): Promise<{
  complete: boolean;
  eligibleOfferCount: number;
  unavailableReasons: { code: UnavailableReason }[];
  options: (CombinationQuote & { expiresAt: string })[];
}> {
  const rows = await pool.query<CandidateRow>(
    `SELECT room_type_id::text AS "roomTypeId", public_offer_key AS "publicOfferKey",
       MIN(CASE WHEN occupancy->>'maxAdults' ~ '^[0-9]{1,6}$' THEN (occupancy->>'maxAdults')::int END) AS "maxAdults",
       MIN(CASE WHEN occupancy->>'maxChildren' ~ '^[0-9]{1,6}$' THEN (occupancy->>'maxChildren')::int END) AS "maxChildren",
       MIN(CASE WHEN occupancy->>'maxOccupancy' ~ '^[0-9]{1,6}$' THEN (occupancy->>'maxOccupancy')::int END) AS "maxOccupancy",
       COUNT(DISTINCT stay_date)::int AS "nightCount",
       bool_and(COALESCE(occupancy->>'maxAdults' ~ '^[0-9]{1,6}$',false)
         AND COALESCE(occupancy->>'maxChildren' ~ '^[0-9]{1,6}$',false)
         AND COALESCE(occupancy->>'maxOccupancy' ~ '^[0-9]{1,6}$',false)) AS "occupancyReady",
       bool_and(freshness_status='fresh' AND (expires_at IS NULL OR expires_at > $5::timestamptz)) AS fresh,
       bool_and(public_visibility='public_safe') AS public,
       bool_and(sellable_publicly AND availability_status IN ('available','limited') AND available_rooms > 0) AS sellable,
       MAX(CASE WHEN rate_summary->>'minStayNights' ~ '^[0-9]{1,6}$' THEN (rate_summary->>'minStayNights')::int END) FILTER (WHERE stay_date=$2::date) AS "minStay",
       MAX(CASE WHEN rate_summary->>'maxStayNights' ~ '^[0-9]{1,6}$' THEN (rate_summary->>'maxStayNights')::int END) FILTER (WHERE stay_date=$2::date) AS "maxStay",
       bool_and((NULLIF(rate_summary->>'minStayNights','') IS NULL OR rate_summary->>'minStayNights' ~ '^[0-9]{1,6}$')
         AND (NULLIF(rate_summary->>'maxStayNights','') IS NULL OR rate_summary->>'maxStayNights' ~ '^[0-9]{1,6}$')) AS "restrictionsReady",
       MIN(expires_at) AS "expiresAt"
     FROM distribution.public_room_offer_snapshots
     WHERE property_id=$1::uuid AND stay_date >= $2::date AND stay_date < $3::date AND currency=$4
     GROUP BY room_type_id, public_offer_key
     ORDER BY room_type_id, public_offer_key`,
    [
      input.propertyId,
      input.checkIn,
      input.checkOut,
      input.currency,
      input.requestedAt.toISOString(),
    ],
  );
  const unavailable = (eligibleOfferCount: number) => ({
    complete: false,
    eligibleOfferCount,
    unavailableReasons: [{ code: "unavailable_data" as const }],
    options: [],
  });
  // Exceeding an internal budget is unavailable data, never a capacity verdict.
  if (rows.rows.length > (input.maxCandidates ?? 250)) return unavailable(0);
  const conflicts = await readPmsRoomSelectionConflicts(
    pool,
    input.propertyId,
    rows.rows.map((row) => row.roomTypeId),
  );
  const candidates: RoomCombinationCandidate[] = [];
  const reasons = new Set<UnavailableReason>();
  const nights = (Date.parse(input.checkOut) - Date.parse(input.checkIn)) / 86_400_000;
  const expiries = new Map<string, string>();
  for (const row of rows.rows) {
    if (!row.occupancyReady || !row.restrictionsReady || row.nightCount !== nights) {
      reasons.add("unavailable_data");
      continue;
    }
    const reason: UnavailableReason | null = !row.public
      ? "unpublished"
      : !row.fresh
        ? "stale_data"
        : !row.sellable
          ? "sold_out"
          : (row.minStay ?? 1) > nights
            ? "min_stay_not_met"
            : row.maxStay !== null && row.maxStay < nights
              ? "max_stay_exceeded"
              : null;
    if (reason) {
      reasons.add(reason);
      continue;
    }
    if (conflicts.get(row.roomTypeId) === undefined) return unavailable(candidates.length);
    try {
      const quote = await quoteTargetRoomSelection(pool, {
        ...input,
        selection: {
          contractVersion: BOOKING_ROOM_SELECTION_VERSION,
          lines: [
            {
              roomTypeId: row.roomTypeId,
              publicOfferKey: row.publicOfferKey,
              guests: [{ adults: 1, children: 0 }],
            },
          ],
        },
      });
      const paymentMethods = quote.paymentOptions.filter((method) =>
        input.paymentMethods.includes(method),
      );
      if (!paymentMethods.length) {
        reasons.add("payment_disabled");
        continue;
      }
      candidates.push({
        ...row,
        availableRooms: Number(quote.lines[0]!.offer.availableRooms),
        currency: quote.currency,
        paymentMethods,
        priceMinor: moneyToCents(quote.totals.totalAmount),
        linkedGroupId: conflicts.get(row.roomTypeId),
      });
      const expiresAt = new Date(
        Math.min(
          input.requestedAt.getTime() + 15 * 60_000,
          row.expiresAt ? new Date(row.expiresAt).getTime() : Infinity,
        ),
      ).toISOString();
      expiries.set(JSON.stringify([row.roomTypeId, row.publicOfferKey]), expiresAt);
    } catch (error) {
      if (!isUnavailableQuote(error)) throw error;
      reasons.add(quoteUnavailableReason(error));
    }
  }
  const result = searchRoomCombinations(candidates, input, { maxWork: input.maxWork });
  if (!result.complete) return unavailable(candidates.length);
  const options: (CombinationQuote & { expiresAt: string })[] = [];
  for (const option of result.options) {
    try {
      // Reprice the full quantity through the same canonical path used by checkout.
      const quote = await quoteTargetRoomSelection(pool, { ...input, selection: option.selection });
      const paymentOptions = quote.paymentOptions.filter((method) =>
        input.paymentMethods.includes(method),
      );
      if (!paymentOptions.length) return unavailable(candidates.length);
      options.push({
        ...quote,
        paymentOptions,
        expiresAt: option.selection.lines
          .map((line) => expiries.get(JSON.stringify([line.roomTypeId, line.publicOfferKey]))!)
          .sort()[0]!,
      });
    } catch (error) {
      if (!isUnavailableQuote(error)) throw error;
      // Evidence moved while evaluating candidates; discarded alternatives may now win.
      return unavailable(candidates.length);
    }
  }
  options.sort((a, b) => {
    const difference = moneyToCents(a.totals.totalAmount) - moneyToCents(b.totals.totalAmount);
    return difference < 0n ? -1 : difference > 0n ? 1 : a.party.rooms - b.party.rooms;
  });
  const uncertain = reasons.has("unavailable_data") || reasons.has("stale_data");
  if (!options.length && !reasons.size && candidates.length) {
    // Distinguish a party that fits only across incompatible payment methods.
    const capacity = searchRoomCombinations(
      candidates.map((candidate) => ({ ...candidate, paymentMethods: ["capacity-probe"] })),
      input,
      { maxWork: input.maxWork },
    );
    if (!capacity.complete) return unavailable(candidates.length);
    reasons.add(capacity.options.length ? "payment_disabled" : "occupancy_unavailable");
  }
  if (!options.length && !reasons.size) reasons.add("unavailable_data");
  return {
    complete:
      options.length > 0 || (!uncertain && reasons.size > 0 && !reasons.has("unavailable_data")),
    unavailableReasons: options.length ? [] : [...reasons].sort().map((code) => ({ code })),
    eligibleOfferCount: candidates.length,
    options,
  };
}

function isUnavailableQuote(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409
  );
}

function quoteUnavailableReason(error: unknown): UnavailableReason {
  if (typeof error === "object" && error !== null && "availabilityReason" in error) {
    if (
      error.availabilityReason === "sold_out" ||
      error.availabilityReason === "payment_disabled" ||
      error.availabilityReason === "stay_restricted" ||
      error.availabilityReason === "min_stay_not_met" ||
      error.availabilityReason === "max_stay_exceeded"
    )
      return error.availabilityReason;
  }
  return "unavailable_data";
}
