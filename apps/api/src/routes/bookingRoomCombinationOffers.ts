import {
  BOOKING_ROOM_SELECTION_VERSION,
  searchRoomCombinations,
  type RoomCombinationCandidate,
} from "@vayada/domain-booking";
import { readPmsRoomSelectionConflicts } from "../domains/pmsRoomSelectionConflicts.js";
import { quoteTargetRoomSelection } from "./bookingWebMixedQuote.js";
import { moneyToCents, type BookingWebQueryExecutor } from "./bookingWebPublic.js";

type CombinationQuote = Awaited<ReturnType<typeof quoteTargetRoomSelection>>;
type CandidateRow = {
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
       MIN(expires_at) AS "expiresAt"
     FROM distribution.public_room_offer_snapshots
     WHERE property_id=$1::uuid AND stay_date >= $2::date AND stay_date < $3::date AND currency=$4
     GROUP BY room_type_id, public_offer_key
     ORDER BY room_type_id, public_offer_key`,
    [input.propertyId, input.checkIn, input.checkOut, input.currency],
  );
  // Exceeding an internal budget is unavailable data, never a capacity verdict.
  if (rows.rows.length > (input.maxCandidates ?? 250))
    return { complete: false, eligibleOfferCount: 0, options: [] };
  const conflicts = await readPmsRoomSelectionConflicts(
    pool,
    input.propertyId,
    rows.rows.map((row) => row.roomTypeId),
  );
  const candidates: RoomCombinationCandidate[] = [];
  let unavailableEvidence = false;
  const expiries = new Map<string, string>();
  for (const row of rows.rows) {
    if (
      !row.occupancyReady ||
      row.nightCount !== (Date.parse(input.checkOut) - Date.parse(input.checkIn)) / 86_400_000
    ) {
      unavailableEvidence = true;
      continue;
    }
    if (conflicts.get(row.roomTypeId) === undefined)
      return { complete: false, eligibleOfferCount: candidates.length, options: [] };
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
      if (!paymentMethods.length) continue;
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
      unavailableEvidence = true;
    }
  }
  const result = searchRoomCombinations(candidates, input, { maxWork: input.maxWork });
  if (!result.complete)
    return { complete: false, eligibleOfferCount: candidates.length, options: [] };
  const options: (CombinationQuote & { expiresAt: string })[] = [];
  for (const option of result.options) {
    try {
      // Reprice the full quantity through the same canonical path used by checkout.
      const quote = await quoteTargetRoomSelection(pool, { ...input, selection: option.selection });
      const paymentOptions = quote.paymentOptions.filter((method) =>
        input.paymentMethods.includes(method),
      );
      if (!paymentOptions.length)
        return { complete: false, eligibleOfferCount: candidates.length, options: [] };
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
      return { complete: false, eligibleOfferCount: candidates.length, options: [] };
    }
  }
  options.sort((a, b) => {
    const difference = moneyToCents(a.totals.totalAmount) - moneyToCents(b.totals.totalAmount);
    return difference < 0n ? -1 : difference > 0n ? 1 : a.party.rooms - b.party.rooms;
  });
  return {
    complete: options.length > 0 || !unavailableEvidence,
    eligibleOfferCount: candidates.length,
    options,
  };
}

function isUnavailableQuote(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409
  );
}
