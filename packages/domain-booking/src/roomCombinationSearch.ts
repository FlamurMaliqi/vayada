import {
  BOOKING_ROOM_SELECTION_VERSION,
  type BookingRoomGuests,
  type BookingRoomLine,
  type BookingRoomSelection,
} from "./roomSelection.js";

/** Full-stay eligible offers only; publication, restrictions and freshness are caller-owned. */
export type RoomCombinationCandidate = {
  roomTypeId: string;
  publicOfferKey: string;
  maxAdults: number;
  maxChildren: number;
  maxOccupancy: number;
  availableRooms: number;
  priceMinor: bigint;
  currency: string;
  paymentMethods: readonly string[];
  linkedGroupId?: string | null;
};
export type RoomCombinationOption = {
  selection: BookingRoomSelection;
  totalMinor: bigint;
  currency: string;
  paymentMethods: string[];
};
type State = {
  adults: number;
  children: number;
  rooms: number;
  groups: string[];
  lines: BookingRoomLine[];
  totalMinor: bigint;
  currency: string;
  paymentMethods: string[];
};

/** Bounds work, never candidates. Incomplete searches must not be reported as no capacity. */
export function searchRoomCombinations(
  candidates: readonly RoomCombinationCandidate[],
  party: { adults: number; children: number },
  limits: { maxWork?: number; maxOptions?: number; minRooms?: number; maxRooms?: number } = {},
): { complete: boolean; options: RoomCombinationOption[] } {
  if (
    !Number.isSafeInteger(party.adults) ||
    party.adults < 1 ||
    party.adults > 99 ||
    !Number.isSafeInteger(party.children) ||
    party.children < 0 ||
    party.children > 99
  ) {
    throw new RangeError("Unsupported guest party");
  }
  const maxWork = limits.maxWork ?? 1_000_000;
  const maxOptions = limits.maxOptions ?? 5;
  const minRooms = limits.minRooms ?? 1;
  const maxRooms = limits.maxRooms ?? 99;
  if (
    !Number.isSafeInteger(minRooms) ||
    minRooms < 1 ||
    !Number.isSafeInteger(maxRooms) ||
    maxRooms < minRooms ||
    maxRooms > 99 ||
    !Number.isSafeInteger(maxWork) ||
    maxWork < 1 ||
    !Number.isSafeInteger(maxOptions) ||
    maxOptions < 1
  ) {
    throw new RangeError("Invalid search limits");
  }
  let work = 0;
  const types = new Map<string, RoomCombinationCandidate[]>();
  for (const candidate of [...candidates].sort(
    (a, b) => compare(a.roomTypeId, b.roomTypeId) || compare(a.publicOfferKey, b.publicOfferKey),
  )) {
    if (++work > maxWork) return { complete: false, options: [] };
    if (
      ![
        candidate.maxAdults,
        candidate.maxChildren,
        candidate.maxOccupancy,
        candidate.availableRooms,
      ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      candidate.maxAdults < 1 ||
      candidate.maxOccupancy < 1 ||
      candidate.availableRooms < 1 ||
      candidate.priceMinor < 0n ||
      !candidate.currency ||
      !candidate.paymentMethods.length
    )
      continue;
    const offers = types.get(candidate.roomTypeId) ?? [];
    offers.push(candidate);
    types.set(candidate.roomTypeId, offers);
  }
  const singles: State[] = [];
  for (const offers of types.values())
    for (const offer of offers) {
      for (
        let quantity = minRooms;
        quantity <= Math.min(offer.availableRooms, party.adults, maxRooms);
        quantity++
      ) {
        if (++work > maxWork) return { complete: false, options: [] };
        const guests = allocate(offer, quantity, party.adults, party.children);
        if (guests)
          singles.push({
            adults: party.adults,
            children: party.children,
            rooms: quantity,
            groups: [],
            lines: [{ roomTypeId: offer.roomTypeId, publicOfferKey: offer.publicOfferKey, guests }],
            totalMinor: offer.priceMinor * BigInt(quantity),
            currency: offer.currency,
            paymentMethods: [...new Set(offer.paymentMethods)].sort(),
          });
      }
    }
  if (singles.length) return result(singles, maxOptions);
  let states = new Map<string, State>();
  const empty: State = {
    adults: 0,
    children: 0,
    rooms: 0,
    groups: [],
    lines: [],
    totalMinor: 0n,
    currency: "",
    paymentMethods: [],
  };
  states.set(key(empty), empty);
  for (const offers of types.values()) {
    // Each room type is processed once: alternative rate plans share its stock.
    const next = new Map(states);
    for (const state of states.values()) {
      if (++work > maxWork) return { complete: false, options: [] };
      for (const offer of offers) {
        if (++work > maxWork) return { complete: false, options: [] };
        if (state.currency && state.currency !== offer.currency) continue;
        if (offer.linkedGroupId && state.groups.includes(offer.linkedGroupId)) continue;
        const paymentMethods = [...new Set(offer.paymentMethods)]
          .filter((method) => !state.lines.length || state.paymentMethods.includes(method))
          .sort();
        if (!paymentMethods.length) continue;
        const remainingAdults = party.adults - state.adults;
        const remainingChildren = party.children - state.children;
        for (
          let quantity = 1;
          quantity <= Math.min(offer.availableRooms, remainingAdults, maxRooms - state.rooms);
          quantity++
        ) {
          for (
            let adults = quantity;
            adults <=
            Math.min(remainingAdults, quantity * Math.min(offer.maxAdults, offer.maxOccupancy));
            adults++
          ) {
            for (
              let children = 0;
              children <=
              Math.min(
                remainingChildren,
                quantity * offer.maxChildren,
                quantity * offer.maxOccupancy - adults,
              );
              children++
            ) {
              if (++work > maxWork) return { complete: false, options: [] };
              const guests = allocate(offer, quantity, adults, children);
              if (!guests) continue;
              const proposed: State = {
                adults: state.adults + adults,
                children: state.children + children,
                rooms: state.rooms + quantity,
                groups: offer.linkedGroupId
                  ? [...state.groups, offer.linkedGroupId].sort()
                  : state.groups,
                lines: [
                  ...state.lines,
                  { roomTypeId: offer.roomTypeId, publicOfferKey: offer.publicOfferKey, guests },
                ],
                totalMinor: state.totalMinor + offer.priceMinor * BigInt(quantity),
                currency: offer.currency,
                paymentMethods,
              };
              const id = key(proposed);
              const existing = next.get(id);
              if (!existing || rank(proposed, existing) < 0) next.set(id, proposed);
            }
          }
        }
      }
    }
    states = next;
  }
  const feasible = [...states.values()].filter(
    (state) =>
      state.adults === party.adults && state.children === party.children && state.rooms >= minRooms,
  );
  return result(feasible, maxOptions);
}

function result(
  states: State[],
  maxOptions: number,
): { complete: boolean; options: RoomCombinationOption[] } {
  return {
    complete: true,
    options: states
      .sort(rank)
      .slice(0, maxOptions)
      .map((state) => ({
        selection: { contractVersion: BOOKING_ROOM_SELECTION_VERSION, lines: state.lines },
        totalMinor: state.totalMinor,
        currency: state.currency,
        paymentMethods: state.paymentMethods,
      })),
  };
}

function allocate(
  offer: RoomCombinationCandidate,
  quantity: number,
  adults: number,
  children: number,
): BookingRoomGuests[] | null {
  const rooms = Array.from({ length: quantity }, () => ({ adults: 1, children: 0 }));
  let remaining = adults - quantity;
  // Fill adult slots that do not reduce child capacity first, then the shared slots.
  for (const cap of [
    Math.min(offer.maxAdults, offer.maxOccupancy - offer.maxChildren),
    Math.min(offer.maxAdults, offer.maxOccupancy),
  ]) {
    for (const room of rooms) {
      const added = Math.min(remaining, Math.max(0, cap - room.adults));
      room.adults += added;
      remaining -= added;
    }
  }
  for (const room of rooms) {
    room.children = Math.min(children, offer.maxChildren, offer.maxOccupancy - room.adults);
    children -= room.children;
  }
  return remaining || children ? null : rooms;
}
function key(state: State): string {
  // Position is implicit in the outer loop; processed types cannot be chosen again.
  // Keep single-type states even if a cheaper mixed state has the same extensions.
  return JSON.stringify([
    state.adults,
    state.children,
    state.rooms,
    state.groups,
    state.currency,
    state.paymentMethods,
    Math.min(2, state.lines.length),
  ]);
}
function rank(a: State, b: State): number {
  return (
    (a.totalMinor < b.totalMinor ? -1 : a.totalMinor > b.totalMinor ? 1 : 0) ||
    a.rooms - b.rooms ||
    compare(JSON.stringify(a.lines), JSON.stringify(b.lines))
  );
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
