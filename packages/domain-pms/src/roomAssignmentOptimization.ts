export type PmsRoomAssignmentOptimizationRoom = Readonly<{
  roomId: string;
  sortOrder: number;
}>;
export type PmsRoomAssignmentOptimizationOccupancy = Readonly<{
  occupancyId: string;
  roomId: string | null;
  checkIn: string;
  checkOut: string;
  movable: boolean;
}>;
export type PmsRoomAssignmentOptimizationMove = Readonly<{
  occupancyId: string;
  fromRoomId: string | null;
  toRoomId: string;
}>;
export type PmsRoomAssignmentOptimizationResult =
  | Readonly<{
      outcome: "optimized";
      moves: readonly PmsRoomAssignmentOptimizationMove[];
      gapNightsBefore: number;
      gapNightsAfter: number;
      usedRoomsBefore: number;
      usedRoomsAfter: number;
    }>
  | Readonly<{
      outcome: "infeasible";
      unassignedOccupancyIds: readonly string[];
    }>
  | Readonly<{
      outcome: "budget_exhausted";
      unassignedOccupancyIds: readonly string[];
    }>;
export type PmsRoomAssignmentOptimizationOptions = Readonly<{
  searchBudget?: number;
}>;
type Interval = Readonly<{ checkIn: string; checkOut: string }>;
type RoomSchedule = {
  room: PmsRoomAssignmentOptimizationRoom;
  fixed: Interval[];
  placed: PmsRoomAssignmentOptimizationOccupancy[];
};
type Candidate = Readonly<{
  schedule: RoomSchedule;
  empty: number;
  gapDelta: number;
  nextGap: number;
  previousGap: number;
  occupancyCount: number;
}>;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Greedily packs one room type. Callers supply blocks, in-house stays, and
 * pinned stays as immovable occupancy; future confirmed stays are movable.
 */
export function optimizePmsRoomAssignments(
  rooms: readonly PmsRoomAssignmentOptimizationRoom[],
  occupancies: readonly PmsRoomAssignmentOptimizationOccupancy[],
  options: PmsRoomAssignmentOptimizationOptions = {},
): PmsRoomAssignmentOptimizationResult {
  validateInput(rooms, occupancies);
  if (
    options.searchBudget !== undefined &&
    (!Number.isSafeInteger(options.searchBudget) ||
      options.searchBudget < 500 ||
      options.searchBudget > 100_000)
  )
    throw new TypeError("PMS assignment optimization search budget is invalid");
  const orderedRooms = [...rooms].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.roomId.localeCompare(right.roomId),
  );
  const roomIds = new Set(orderedRooms.map(({ roomId }) => roomId));
  const schedules = new Map<string, RoomSchedule>(
    orderedRooms.map((room) => [room.roomId, { room, fixed: [], placed: [] }]),
  );
  for (const occupancy of occupancies.filter(({ movable }) => !movable)) {
    if (!occupancy.roomId || !roomIds.has(occupancy.roomId)) {
      return { outcome: "infeasible", unassignedOccupancyIds: [occupancy.occupancyId] };
    }
    schedules.get(occupancy.roomId)!.fixed.push(occupancy);
  }
  for (const schedule of schedules.values()) schedule.fixed = mergeIntervals(schedule.fixed);
  const assigned = new Map<string, string>();
  const movable = occupancies
    .filter(({ movable: canMove }) => canMove)
    .map((occupancy) => ({
      occupancy,
      fixedCandidateCount: [...schedules.values()].filter(({ fixed }) =>
        fitsIntervals(fixed, occupancy),
      ).length,
    }))
    .sort(
      (left, right) =>
        left.fixedCandidateCount - right.fixedCandidateCount ||
        left.occupancy.checkIn.localeCompare(right.occupancy.checkIn) ||
        right.occupancy.checkOut.localeCompare(left.occupancy.checkOut) ||
        left.occupancy.occupancyId.localeCompare(right.occupancy.occupancyId),
    );
  if (
    peakDemandExceedsRoomCount(
      [...schedules.values()],
      movable.map(({ occupancy }) => occupancy),
    )
  )
    return {
      outcome: "infeasible",
      unassignedOccupancyIds: movable.map(({ occupancy }) => occupancy.occupancyId),
    };

  let greedyFailed = false;
  for (const { occupancy } of movable) {
    const candidate = orderedRooms
      .map((room) => scoreCandidate(schedules.get(room.roomId)!, occupancy))
      .filter((value): value is Candidate => value !== null)
      .sort(compareCandidates)[0];
    if (!candidate) {
      greedyFailed = true;
      break;
    }
    assigned.set(occupancy.occupancyId, candidate.schedule.room.roomId);
    insertInterval(candidate.schedule.placed, occupancy);
  }
  if (greedyFailed) {
    assigned.clear();
    for (const schedule of schedules.values()) schedule.placed = [];
    const pending = movable.map(({ occupancy }) => occupancy);
    const search = {
      count: 0,
      budget:
        options.searchBudget ??
        Math.max(5_000, Math.min(50_000, pending.length * orderedRooms.length * 100)),
      exhausted: false,
    };
    if (!searchPlacement([...schedules.values()], pending, assigned, search, new Set())) {
      return {
        outcome: search.exhausted ? "budget_exhausted" : "infeasible",
        unassignedOccupancyIds: pending.map(({ occupancyId }) => occupancyId),
      };
    }
  }

  const gapNightsBefore = totalGapNights(orderedRooms, occupancies);
  const gapNightsAfter = [...schedules.values()].reduce(
    (total, schedule) => total + intervalGapNights([...schedule.fixed, ...schedule.placed]),
    0,
  );
  const usedRoomsBefore = usedRoomCount(orderedRooms, occupancies);
  const usedRoomsAfter = [...schedules.values()].filter(
    ({ fixed, placed }) => fixed.length + placed.length > 0,
  ).length;
  const keepExisting =
    occupancies.every(({ roomId }) => roomId !== null) &&
    originalAssignmentIsFeasible(orderedRooms, occupancies) &&
    (usedRoomsAfter > usedRoomsBefore ||
      (usedRoomsAfter === usedRoomsBefore && gapNightsAfter > gapNightsBefore));

  return {
    outcome: "optimized",
    moves: keepExisting
      ? []
      : movable
          .map(({ occupancy }) => ({
            occupancyId: occupancy.occupancyId,
            fromRoomId: occupancy.roomId,
            toRoomId: assigned.get(occupancy.occupancyId)!,
          }))
          .filter(({ fromRoomId, toRoomId }) => fromRoomId !== toRoomId),
    gapNightsBefore,
    gapNightsAfter: keepExisting ? gapNightsBefore : gapNightsAfter,
    usedRoomsBefore,
    usedRoomsAfter: keepExisting ? usedRoomsBefore : usedRoomsAfter,
  };
}
function searchPlacement(
  schedules: readonly RoomSchedule[],
  pending: readonly PmsRoomAssignmentOptimizationOccupancy[],
  assigned: Map<string, string>,
  nodes: { count: number; budget: number; exhausted: boolean },
  seen: Set<string>,
): boolean {
  if (pending.length === 0) return true;
  if (nodes.count >= nodes.budget) {
    nodes.exhausted = true;
    return false;
  }
  const state = `${pending
    .map(({ occupancyId }) => occupancyId)
    .sort()
    .join(",")}|${schedules
    .map(
      ({ room, placed }) =>
        `${room.roomId}:${placed.map(({ occupancyId }) => occupancyId).join(",")}`,
    )
    .join("|")}`;
  if (seen.has(state)) return false;
  seen.add(state);
  const choices = pending
    .map((occupancy) => ({
      occupancy,
      candidates: schedules
        .map((schedule) => scoreCandidate(schedule, occupancy))
        .filter((candidate): candidate is Candidate => candidate !== null)
        .sort(compareCandidates),
    }))
    .sort(
      (left, right) =>
        left.candidates.length - right.candidates.length ||
        left.occupancy.checkIn.localeCompare(right.occupancy.checkIn) ||
        right.occupancy.checkOut.localeCompare(left.occupancy.checkOut) ||
        left.occupancy.occupancyId.localeCompare(right.occupancy.occupancyId),
    )[0]!;
  const remaining = pending.filter(
    ({ occupancyId }) => occupancyId !== choices.occupancy.occupancyId,
  );
  for (const candidate of choices.candidates) {
    nodes.count += 1;
    assigned.set(choices.occupancy.occupancyId, candidate.schedule.room.roomId);
    insertInterval(candidate.schedule.placed, choices.occupancy);
    if (searchPlacement(schedules, remaining, assigned, nodes, seen)) return true;
    candidate.schedule.placed.splice(candidate.schedule.placed.indexOf(choices.occupancy), 1);
    assigned.delete(choices.occupancy.occupancyId);
  }
  return false;
}
function peakDemandExceedsRoomCount(
  schedules: readonly RoomSchedule[],
  movable: readonly PmsRoomAssignmentOptimizationOccupancy[],
): boolean {
  const events = [...schedules.flatMap(({ fixed }) => fixed), ...movable].flatMap(
    ({ checkIn, checkOut }) => [
      { date: checkIn, delta: 1 },
      { date: checkOut, delta: -1 },
    ],
  );
  events.sort((left, right) => left.date.localeCompare(right.date) || left.delta - right.delta);
  let concurrent = 0;
  for (const event of events) {
    concurrent += event.delta;
    if (concurrent > schedules.length) return true;
  }
  return false;
}
function scoreCandidate(schedule: RoomSchedule, occupancy: Interval): Candidate | null {
  const fixedIndex = firstStartingAtOrAfter(schedule.fixed, occupancy.checkOut);
  const placedIndex = firstStartingAtOrAfter(schedule.placed, occupancy.checkOut);
  const previousFixed = schedule.fixed[fixedIndex - 1];
  const previousPlaced = schedule.placed[placedIndex - 1];
  if (
    (previousFixed && overlaps(previousFixed, occupancy)) ||
    (previousPlaced && overlaps(previousPlaced, occupancy))
  )
    return null;
  const previous = [previousFixed, previousPlaced]
    .filter((value): value is Interval => value !== undefined)
    .sort((left, right) => right.checkOut.localeCompare(left.checkOut))[0];
  const next = [schedule.fixed[fixedIndex], schedule.placed[placedIndex]]
    .filter((value): value is Interval => value !== undefined)
    .sort((left, right) => left.checkIn.localeCompare(right.checkIn))[0];
  const previousGap = previous
    ? nightsBetween(previous.checkOut, occupancy.checkIn)
    : Number.POSITIVE_INFINITY;
  const nextGap = next ? nightsBetween(occupancy.checkOut, next.checkIn) : Number.POSITIVE_INFINITY;
  const oldGap = previous && next ? nightsBetween(previous.checkOut, next.checkIn) : 0;
  return {
    schedule,
    empty: schedule.fixed.length + schedule.placed.length === 0 ? 1 : 0,
    gapDelta:
      (Number.isFinite(previousGap) ? previousGap : 0) +
      (Number.isFinite(nextGap) ? nextGap : 0) -
      oldGap,
    nextGap,
    previousGap,
    occupancyCount: schedule.fixed.length + schedule.placed.length,
  };
}
function fitsIntervals(intervals: readonly Interval[], occupancy: Interval): boolean {
  const index = firstStartingAtOrAfter(intervals, occupancy.checkOut);
  return !intervals[index - 1] || !overlaps(intervals[index - 1]!, occupancy);
}
function insertInterval(intervals: Interval[], occupancy: Interval): void {
  intervals.splice(firstStartingAtOrAfter(intervals, occupancy.checkIn), 0, occupancy);
}
function compareCandidates(left: Candidate, right: Candidate): number {
  return (
    left.empty - right.empty ||
    left.gapDelta - right.gapDelta ||
    left.nextGap - right.nextGap ||
    left.previousGap - right.previousGap ||
    right.occupancyCount - left.occupancyCount ||
    left.schedule.room.sortOrder - right.schedule.room.sortOrder ||
    left.schedule.room.roomId.localeCompare(right.schedule.room.roomId)
  );
}
function totalGapNights(
  rooms: readonly PmsRoomAssignmentOptimizationRoom[],
  occupancies: readonly PmsRoomAssignmentOptimizationOccupancy[],
): number {
  return rooms.reduce(
    (total, { roomId }) =>
      total + intervalGapNights(occupancies.filter((occupancy) => occupancy.roomId === roomId)),
    0,
  );
}
function usedRoomCount(
  rooms: readonly PmsRoomAssignmentOptimizationRoom[],
  occupancies: readonly PmsRoomAssignmentOptimizationOccupancy[],
): number {
  const known = new Set(rooms.map(({ roomId }) => roomId));
  return new Set(
    occupancies
      .map(({ roomId }) => roomId)
      .filter((roomId): roomId is string => roomId !== null && known.has(roomId)),
  ).size;
}
function originalAssignmentIsFeasible(
  rooms: readonly PmsRoomAssignmentOptimizationRoom[],
  occupancies: readonly PmsRoomAssignmentOptimizationOccupancy[],
): boolean {
  const known = new Set(rooms.map(({ roomId }) => roomId));
  if (occupancies.some(({ roomId }) => !roomId || !known.has(roomId))) return false;
  return rooms.every(({ roomId }) => {
    const ordered = occupancies
      .filter((occupancy) => occupancy.roomId === roomId)
      .sort((left, right) => left.checkIn.localeCompare(right.checkIn));
    return ordered.slice(1).every((item, index) => !overlaps(ordered[index]!, item));
  });
}
function firstStartingAtOrAfter(intervals: readonly Interval[], date: string): number {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (intervals[middle]!.checkIn < date) low = middle + 1;
    else high = middle;
  }
  return low;
}
function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.checkIn.localeCompare(b.checkIn))) {
    const previous = merged.at(-1);
    if (!previous || previous.checkOut < interval.checkIn) merged.push({ ...interval });
    else if (previous.checkOut < interval.checkOut)
      merged[merged.length - 1] = { checkIn: previous.checkIn, checkOut: interval.checkOut };
  }
  return merged;
}
function intervalGapNights(intervals: readonly Interval[]): number {
  const ordered = [...intervals].sort(
    (left, right) =>
      left.checkIn.localeCompare(right.checkIn) || left.checkOut.localeCompare(right.checkOut),
  );
  let total = 0;
  let occupiedThrough = ordered[0]?.checkOut;
  for (const interval of ordered.slice(1)) {
    if (occupiedThrough! < interval.checkIn)
      total += nightsBetween(occupiedThrough!, interval.checkIn);
    if (occupiedThrough! < interval.checkOut) occupiedThrough = interval.checkOut;
  }
  return total;
}
function overlaps(left: Interval, right: Interval): boolean {
  return left.checkIn < right.checkOut && right.checkIn < left.checkOut;
}
function nightsBetween(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
}
function validateInput(
  rooms: readonly PmsRoomAssignmentOptimizationRoom[],
  occupancies: readonly PmsRoomAssignmentOptimizationOccupancy[],
): void {
  if (new Set(rooms.map(({ roomId }) => roomId)).size !== rooms.length)
    throw new TypeError("PMS assignment optimization rooms must be unique");
  if (new Set(occupancies.map(({ occupancyId }) => occupancyId)).size !== occupancies.length)
    throw new TypeError("PMS assignment optimization occupancies must be unique");
  if (rooms.some(({ roomId, sortOrder }) => !roomId || !Number.isSafeInteger(sortOrder)))
    throw new TypeError("PMS assignment optimization room is invalid");
  if (
    occupancies.some(
      ({ occupancyId, checkIn, checkOut }) =>
        !occupancyId || !validDate(checkIn) || !validDate(checkOut) || checkIn >= checkOut,
    )
  )
    throw new TypeError("PMS assignment optimization occupancy is invalid");
}
function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
