import {
  parsePmsOperatingCalendarConfigurationSnapshot,
  parsePmsOperatingCalendarSourceRevision,
  type PmsOperatingCalendarCanonicalTimeZoneRegistry,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarRoomBinding,
  type PmsOperatingCalendarSourceRevision,
  type PmsOperatingSchedule,
} from "./operatingCalendar.js";
import {
  PMS_INVENTORY_HORIZON_MAX_DAYS,
  type PmsInventoryCoverageEvidence,
  type PmsInventoryDaySnapshot,
  type PmsInventoryRequiredCoverage,
} from "./inventoryMaterialization.js";

const MAX_REVISION = 2_147_483_647;
const DAY_MS = 86_400_000;
const DAY_KEYS = [
  "propertyId",
  "roomTypeId",
  "stayDate",
  "calendarRevision",
  "inventoryRevision",
  "sourceRevisions",
  "operatingStatus",
  "physicalCapacityCount",
  "generatedSellableLimitCount",
  "channelSellableLimitCount",
  "manualSellableLimitCount",
  "effectiveSellableLimitCount",
  "assignedCount",
  "blockedCount",
  "linkedStopSell",
  "linkedSourceRevision",
  "availableCount",
] as const;
const SOURCE_REVISION_KEYS = ["generated", "channel", "manual", "block", "booking"] as const;

export type PmsInventoryMaterializationPlannerInput = Readonly<{
  propertyId: string;
  configurationSource: PmsOperatingCalendarSourceRevision;
  configuration: PmsOperatingCalendarConfigurationSnapshot;
  horizon: PmsInventoryRequiredCoverage;
  currentDays: readonly PmsInventoryDaySnapshot[];
}>;

export type PmsInventoryMaterializationPlanError =
  | Readonly<{ code: "invalid_input" | "configuration_scope_mismatch" | "horizon_invalid" }>
  | Readonly<{ code: "current_day_invalid"; index: number }>
  | Readonly<{
      code:
        | "current_day_scope_invalid"
        | "current_day_duplicate"
        | "inventory_invariant_violation"
        | "generated_revision_conflict";
      roomTypeId: string;
      stayDate: string;
    }>
  | Readonly<{ code: "current_day_coverage_gap"; stayDate: string }>;

export type PmsInventoryMaterializationPlan =
  | Readonly<{
      ok: true;
      outcome: "applied" | "extended" | "rematerialized" | "unchanged";
      days: readonly PmsInventoryDaySnapshot[];
      changedDays: readonly PmsInventoryDaySnapshot[];
      coverage: PmsInventoryCoverageEvidence;
    }>
  | Readonly<{ ok: false; error: PmsInventoryMaterializationPlanError }>;

/** Pure planner. Locking, owner reads, persistence, audit, and outbox stay in the adapter. */
export function planPmsInventoryMaterialization(
  input: PmsInventoryMaterializationPlannerInput,
): PmsInventoryMaterializationPlan {
  if (!validInputShape(input)) return failure({ code: "invalid_input" });
  const configuration = parseConfiguration(input.configuration);
  const requestedSource = parsePmsOperatingCalendarSourceRevision(input.configurationSource);
  if (
    !configuration ||
    !requestedSource ||
    input.propertyId !== configuration.propertyId ||
    !sameSource(requestedSource, configuration.source) ||
    !sameSource(input.configurationSource, configuration.source)
  ) {
    return failure({ code: "configuration_scope_mismatch" });
  }
  const dates = horizonDates(input.horizon);
  if (!dates) return failure({ code: "horizon_invalid" });

  const bindings = configuration.sourceInputs.roomBindings;
  const bindingByRoom = new Map(bindings.map((binding) => [binding.roomTypeId, binding]));
  const expectedDates = new Set(dates);

  const currentByKey = new Map<string, PmsInventoryDaySnapshot>();
  const countByDate = new Map<string, number>();
  for (let index = 0; index < input.currentDays.length; index += 1) {
    const current = parseCurrentDay(input.currentDays[index]);
    if (!current) return failure({ code: "current_day_invalid", index });
    const key = dayKey(current.roomTypeId, current.stayDate);
    if (
      current.propertyId !== configuration.propertyId ||
      !bindingByRoom.has(current.roomTypeId) ||
      !expectedDates.has(current.stayDate)
    ) {
      return failure({
        code: "current_day_scope_invalid",
        roomTypeId: current.roomTypeId,
        stayDate: current.stayDate,
      });
    }
    if (currentByKey.has(key)) {
      return failure({
        code: "current_day_duplicate",
        roomTypeId: current.roomTypeId,
        stayDate: current.stayDate,
      });
    }
    currentByKey.set(key, current);
    countByDate.set(current.stayDate, (countByDate.get(current.stayDate) ?? 0) + 1);
  }

  let missingSuffix = false;
  for (const stayDate of dates) {
    const count = countByDate.get(stayDate) ?? 0;
    if (count !== 0 && count !== bindings.length) {
      return failure({ code: "current_day_coverage_gap", stayDate });
    }
    if (count === 0) missingSuffix = true;
    else if (missingSuffix) return failure({ code: "current_day_coverage_gap", stayDate });
  }

  const days: PmsInventoryDaySnapshot[] = [];
  const changedDays: PmsInventoryDaySnapshot[] = [];
  let changedExisting = false;
  for (const binding of bindings) {
    for (const stayDate of dates) {
      const current = currentByKey.get(dayKey(binding.roomTypeId, stayDate));
      const planned = current
        ? planExistingDay(configuration, binding, stayDate, current)
        : newDay(configuration, binding, stayDate);
      if ("error" in planned) return failure(planned.error);
      days.push(planned.day);
      if (!current || planned.changed) changedDays.push(planned.day);
      if (current && planned.changed) changedExisting = true;
    }
  }
  days.sort(compareDays);
  changedDays.sort(compareDays);

  const outcome =
    input.currentDays.length === 0
      ? "applied"
      : changedExisting
        ? "rematerialized"
        : missingSuffix
          ? "extended"
          : "unchanged";
  const roomTypeIds = bindings.map(({ roomTypeId }) => roomTypeId).sort(compareCodeUnits);
  const coverage = Object.freeze({
    configurationSource: configuration.source,
    materializedRevision: configuration.calendarRevision,
    coverageFrom: input.horizon.from,
    coverageThrough: input.horizon.through,
    roomTypeIds: Object.freeze(roomTypeIds),
    expectedDayCount: days.length,
    materializedDayCount: days.length,
    gaps: Object.freeze([]),
  });
  return Object.freeze({
    ok: true,
    outcome,
    days: Object.freeze(days),
    changedDays: Object.freeze(changedDays),
    coverage,
  });
}

function planExistingDay(
  configuration: PmsOperatingCalendarConfigurationSnapshot,
  binding: PmsOperatingCalendarRoomBinding,
  stayDate: string,
  current: PmsInventoryDaySnapshot,
): Readonly<
  | { day: PmsInventoryDaySnapshot; changed: boolean }
  | { error: PmsInventoryMaterializationPlanError }
> {
  const errorKey = { roomTypeId: current.roomTypeId, stayDate: current.stayDate };
  if (current.sourceRevisions.generated > configuration.calendarRevision) {
    return { error: { code: "generated_revision_conflict", ...errorKey } };
  }
  if (!validCurrentInvariant(current, binding)) {
    return { error: { code: "inventory_invariant_violation", ...errorKey } };
  }
  const operatingStatus = operatingStatusFor(configuration.schedule, stayDate);
  const effectiveSellableLimitCount =
    current.manualSellableLimitCount ??
    current.channelSellableLimitCount ??
    binding.startingSellableLimitCount;
  if (effectiveSellableLimitCount > binding.physicalCapacityCount) {
    return { error: { code: "inventory_invariant_violation", ...errorKey } };
  }
  const availableCount =
    operatingStatus === "closed" || current.linkedStopSell
      ? 0
      : Math.max(0, effectiveSellableLimitCount - current.assignedCount - current.blockedCount);
  const changed =
    current.calendarRevision !== configuration.calendarRevision ||
    current.sourceRevisions.generated !== configuration.calendarRevision ||
    current.operatingStatus !== operatingStatus ||
    current.generatedSellableLimitCount !== binding.startingSellableLimitCount ||
    current.effectiveSellableLimitCount !== effectiveSellableLimitCount ||
    current.availableCount !== availableCount;
  if (!changed) return { day: current, changed: false };
  if (current.inventoryRevision === MAX_REVISION) {
    return { error: { code: "inventory_invariant_violation", ...errorKey } };
  }
  return {
    changed: true,
    day: freezeDay({
      ...current,
      calendarRevision: configuration.calendarRevision,
      inventoryRevision: current.inventoryRevision + 1,
      sourceRevisions: { ...current.sourceRevisions, generated: configuration.calendarRevision },
      operatingStatus,
      generatedSellableLimitCount: binding.startingSellableLimitCount,
      effectiveSellableLimitCount,
      availableCount,
    }),
  };
}

function newDay(
  configuration: PmsOperatingCalendarConfigurationSnapshot,
  binding: PmsOperatingCalendarRoomBinding,
  stayDate: string,
): Readonly<{ day: PmsInventoryDaySnapshot; changed: true }> {
  const operatingStatus = operatingStatusFor(configuration.schedule, stayDate);
  return {
    changed: true,
    day: freezeDay({
      propertyId: configuration.propertyId,
      roomTypeId: binding.roomTypeId,
      stayDate,
      calendarRevision: configuration.calendarRevision,
      inventoryRevision: 1,
      sourceRevisions: {
        generated: configuration.calendarRevision,
        channel: 0,
        manual: 0,
        block: 0,
        booking: 0,
      },
      operatingStatus,
      physicalCapacityCount: binding.physicalCapacityCount,
      generatedSellableLimitCount: binding.startingSellableLimitCount,
      channelSellableLimitCount: null,
      manualSellableLimitCount: null,
      effectiveSellableLimitCount: binding.startingSellableLimitCount,
      assignedCount: 0,
      blockedCount: 0,
      linkedStopSell: false,
      linkedSourceRevision: 0,
      availableCount: operatingStatus === "open" ? binding.startingSellableLimitCount : 0,
    }),
  };
}

function validCurrentInvariant(
  day: PmsInventoryDaySnapshot,
  binding: PmsOperatingCalendarRoomBinding,
): boolean {
  const retainedLimit = day.manualSellableLimitCount ?? day.channelSellableLimitCount;
  const effectiveLimit = retainedLimit === null ? day.generatedSellableLimitCount : retainedLimit;
  const available =
    day.operatingStatus === "closed" || day.linkedStopSell
      ? 0
      : Math.max(0, effectiveLimit - day.assignedCount - day.blockedCount);
  return (
    day.calendarRevision === day.sourceRevisions.generated &&
    day.physicalCapacityCount === binding.physicalCapacityCount &&
    day.generatedSellableLimitCount <= day.physicalCapacityCount &&
    (day.channelSellableLimitCount === null ||
      day.channelSellableLimitCount <= day.physicalCapacityCount) &&
    (day.manualSellableLimitCount === null ||
      day.manualSellableLimitCount <= day.physicalCapacityCount) &&
    day.assignedCount + day.blockedCount <= day.physicalCapacityCount &&
    day.effectiveSellableLimitCount === effectiveLimit &&
    day.availableCount === available
  );
}

function parseCurrentDay(value: unknown): PmsInventoryDaySnapshot | null {
  if (!dataRecord(value, DAY_KEYS)) return null;
  const sourceRevisions = value.sourceRevisions;
  if (!dataRecord(sourceRevisions, SOURCE_REVISION_KEYS)) return null;
  if (
    typeof value.propertyId !== "string" ||
    typeof value.roomTypeId !== "string" ||
    isoDateTimestamp(value.stayDate) === null ||
    !revision(value.calendarRevision, false) ||
    !revision(value.inventoryRevision, false) ||
    !SOURCE_REVISION_KEYS.every((key) => revision(sourceRevisions[key], true)) ||
    (value.operatingStatus !== "open" && value.operatingStatus !== "closed") ||
    !count(value.physicalCapacityCount, 1, 500) ||
    !count(value.generatedSellableLimitCount, 0, 500) ||
    !(value.channelSellableLimitCount === null || count(value.channelSellableLimitCount, 0, 500)) ||
    !(value.manualSellableLimitCount === null || count(value.manualSellableLimitCount, 0, 500)) ||
    !count(value.effectiveSellableLimitCount, 0, 500) ||
    !count(value.assignedCount, 0, 500) ||
    !count(value.blockedCount, 0, 500) ||
    typeof value.linkedStopSell !== "boolean" ||
    !revision(value.linkedSourceRevision, true) ||
    !count(value.availableCount, 0, 500)
  ) {
    return null;
  }
  return freezeDay(value as PmsInventoryDaySnapshot);
}

function parseConfiguration(value: unknown): PmsOperatingCalendarConfigurationSnapshot | null {
  if (!safeConfigurationShape(value)) return null;
  const registry: PmsOperatingCalendarCanonicalTimeZoneRegistry = {
    ownerDomain: "hotel_catalog",
    registryVersion: "accepted-operating-calendar.v1",
    isCanonicalIanaTimeZone: (candidate) => candidate === value.sourceInputs.propertyTimeZone,
  };
  return parsePmsOperatingCalendarConfigurationSnapshot(value, registry);
}

function safeConfigurationShape(
  value: unknown,
): value is PmsOperatingCalendarConfigurationSnapshot {
  if (
    !dataRecord(value, [
      "contractVersion",
      "propertyId",
      "calendarRevision",
      "source",
      "sourceInputs",
      "schedule",
      "defaultMinimumStayNights",
      "createdAt",
      "updatedAt",
    ]) ||
    !dataRecord(value.source, ["ownerDomain", "entityType", "entityId", "revision"]) ||
    !dataRecord(value.sourceInputs, ["propertyProfile", "propertyTimeZone", "roomBindings"]) ||
    !dataRecord(value.sourceInputs.propertyProfile, [
      "ownerDomain",
      "entityType",
      "entityId",
      "revision",
    ]) ||
    !denseArray(value.sourceInputs.roomBindings) ||
    !value.sourceInputs.roomBindings.every((binding) =>
      dataRecord(binding, [
        "roomTypeId",
        "sourceRoomFactsRevision",
        "sourceRoomUnitsRevision",
        "physicalCapacityCount",
        "startingSellableLimitCount",
      ]),
    ) ||
    !dataRecord(value.schedule, ["mode", "periods"]) ||
    !denseArray(value.schedule.periods) ||
    !value.schedule.periods.every((period) => dataRecord(period, ["startsOn", "endsOn"]))
  ) {
    return false;
  }
  return true;
}

function validInputShape(value: unknown): value is PmsInventoryMaterializationPlannerInput {
  return (
    dataRecord(value, [
      "propertyId",
      "configurationSource",
      "configuration",
      "horizon",
      "currentDays",
    ]) &&
    dataRecord(value.configurationSource, ["ownerDomain", "entityType", "entityId", "revision"]) &&
    dataRecord(value.horizon, ["from", "through"]) &&
    denseArray(value.currentDays)
  );
}

function operatingStatusFor(schedule: PmsOperatingSchedule, stayDate: string): "open" | "closed" {
  if (schedule.mode === "year_round") return "open";
  const monthDay = stayDate.slice(5);
  return schedule.periods.some(({ startsOn, endsOn }) =>
    startsOn <= endsOn
      ? monthDay >= startsOn && monthDay <= endsOn
      : monthDay >= startsOn || monthDay <= endsOn,
  )
    ? "open"
    : "closed";
}

function horizonDates(horizon: PmsInventoryRequiredCoverage): readonly string[] | null {
  if (!dataRecord(horizon, ["from", "through"])) return null;
  const from = isoDateTimestamp(horizon.from);
  const through = isoDateTimestamp(horizon.through);
  if (from === null || through === null) return null;
  const dayCount = (through - from) / DAY_MS + 1;
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > PMS_INVENTORY_HORIZON_MAX_DAYS) {
    return null;
  }
  return Object.freeze(
    Array.from({ length: dayCount }, (_, offset) =>
      new Date(from + offset * DAY_MS).toISOString().slice(0, 10),
    ),
  );
}

function isoDateTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year!, month! - 1, day!);
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function dataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
    })
  );
}

function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
}

function freezeDay(day: PmsInventoryDaySnapshot): PmsInventoryDaySnapshot {
  return Object.freeze({
    ...day,
    sourceRevisions: Object.freeze({ ...day.sourceRevisions }),
  });
}

function failure(error: PmsInventoryMaterializationPlanError): PmsInventoryMaterializationPlan {
  return Object.freeze({ ok: false, error: Object.freeze(error) });
}

function sameSource(
  left: PmsOperatingCalendarSourceRevision,
  right: PmsOperatingCalendarSourceRevision,
): boolean {
  return (
    left.ownerDomain === right.ownerDomain &&
    left.entityType === right.entityType &&
    left.entityId === right.entityId &&
    left.revision === right.revision
  );
}

function dayKey(roomTypeId: string, stayDate: string): string {
  return `${roomTypeId}|${stayDate}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDays(left: PmsInventoryDaySnapshot, right: PmsInventoryDaySnapshot): number {
  return (
    compareCodeUnits(left.roomTypeId, right.roomTypeId) ||
    compareCodeUnits(left.stayDate, right.stayDate)
  );
}

function revision(value: unknown, allowZero: boolean): value is number {
  return (
    Number.isSafeInteger(value) &&
    (allowZero ? (value as number) >= 0 : (value as number) >= 1) &&
    (value as number) <= MAX_REVISION
  );
}

function count(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}
