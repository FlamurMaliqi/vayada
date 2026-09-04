import { createHash } from "node:crypto";

export const PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION = "pms-calendar-auto-open.v1" as const;
export const PMS_CALENDAR_AUTO_OPEN_SOURCE_CONTRACT_VERSION =
  "pms-calendar-auto-open-source.v1" as const;
export const PMS_CALENDAR_AUTO_OPEN_ROLLING_MONTHS = [12, 18, 24] as const;
export const PMS_CALENDAR_AUTO_OPEN_MAX_FIXED_MONTHS = 24 as const;
export const PMS_CALENDAR_AUTO_OPEN_MAX_HORIZON_DAYS = 762 as const;

export type PmsCalendarAutoOpenConfiguration = Readonly<{
  enabled: boolean;
  mode: "rolling" | "fixed";
  rollingMonths: 12 | 18 | 24 | null;
  fixedEndMonth: string | null;
}>;

export type PmsCalendarAutoOpenSetting = PmsCalendarAutoOpenConfiguration &
  Readonly<{
    contractVersion: typeof PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION;
    propertyId: string;
    revision: number;
    updatedAt: string | null;
  }>;

export type PmsCalendarAutoOpenSettingContext = Readonly<{
  setting: PmsCalendarAutoOpenSetting;
  propertyTimeZone: string;
  warnings: readonly PmsCalendarAutoOpenWarning[];
  setupError: PmsCalendarAutoOpenSetupError | null;
}>;

export type PmsCalendarAutoOpenHorizon = Readonly<{
  propertyTimeZone: string;
  propertyLocalDate: string;
  targetOpenThrough: string | null;
}>;

export type PmsCalendarAutoOpenRead = Readonly<{
  setting: PmsCalendarAutoOpenSetting;
  horizon: PmsCalendarAutoOpenHorizon;
  warnings: readonly PmsCalendarAutoOpenWarning[];
  setupError: PmsCalendarAutoOpenSetupError | null;
}>;

export type PmsCalendarAutoOpenSetupError = Readonly<{
  code:
    | "operating_calendar_not_configured"
    | "operating_calendar_room_bindings_stale"
    | "physical_room_labels_unverified";
}>;

export type PmsCalendarAutoOpenWarning = Readonly<{
  code: "missing_rate";
  roomTypeId: string;
  from: string;
  through: string;
}>;

export type PmsCalendarAutoOpenSource = Readonly<{
  contractVersion: typeof PMS_CALENDAR_AUTO_OPEN_SOURCE_CONTRACT_VERSION;
  settingRevision: number;
  propertyProfileRevision: number;
  propertyTimeZone: string;
  operatingCalendarRevision: number;
  rooms: readonly Readonly<{
    roomTypeId: string;
    roomFactsRevision: number;
    roomUnitsRevision: number;
  }>[];
  pricing: Readonly<{
    pricingCurrencyRevision: number;
    flexibleRatePlans: readonly Readonly<{
      roomTypeId: string;
      flexibleRatePlanRevision: number;
    }>[];
    optionalPricingAggregateRevision: number;
  }>;
}>;

export const PMS_CALENDAR_AUTO_OPEN_DEFAULT_CONFIGURATION = Object.freeze({
  enabled: false,
  mode: "rolling",
  rollingMonths: 18,
  fixedEndMonth: null,
} satisfies PmsCalendarAutoOpenConfiguration);

export type UpdatePmsCalendarAutoOpenSetting = PmsCalendarAutoOpenConfiguration &
  Readonly<{
    propertyId: string;
    expectedRevision: number;
    idempotencyKey: string;
    audit: {
      actorUserId: string;
      requestId: string;
      correlationId: string | null;
      requestedAt: string;
    };
  }>;

export type PmsCalendarAutoOpenUpdateResult =
  | Readonly<{
      ok: true;
      outcome: "created" | "updated" | "unchanged";
      setting: PmsCalendarAutoOpenSetting;
      propertyTimeZone: string;
      evaluatedAt: string;
      enqueueIntentId: string | null;
    }>
  | Readonly<{
      ok: false;
      error:
        | Readonly<{
            code:
              | "invalid_setting"
              | "property_not_found"
              | "property_time_zone_invalid"
              | PmsCalendarAutoOpenSetupError["code"]
              | "idempotency_key_conflict"
              | "command_in_progress";
          }>
        | Readonly<{ code: "calendar_auto_open_revision_conflict"; currentRevision: number }>;
    }>;

export type PmsCalendarAutoOpenSettingsPort = {
  find(propertyId: string): Promise<PmsCalendarAutoOpenSetting | null>;
  findContext(propertyId: string): Promise<PmsCalendarAutoOpenSettingContext | null>;
  update(command: UpdatePmsCalendarAutoOpenSetting): Promise<PmsCalendarAutoOpenUpdateResult>;
  close?(): Promise<void>;
};

const FIXED_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/u;

export function isPmsCalendarAutoOpenConfiguration(
  value: unknown,
): value is PmsCalendarAutoOpenConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PmsCalendarAutoOpenConfiguration>;
  if (typeof candidate.enabled !== "boolean") return false;
  if (candidate.mode === "rolling")
    return (
      PMS_CALENDAR_AUTO_OPEN_ROLLING_MONTHS.includes(candidate.rollingMonths as 12 | 18 | 24) &&
      candidate.fixedEndMonth === null
    );
  if (candidate.mode !== "fixed" || candidate.rollingMonths !== null) return false;
  const match =
    typeof candidate.fixedEndMonth === "string" ? FIXED_MONTH.exec(candidate.fixedEndMonth) : null;
  return match !== null && Number(match[1]) > 0;
}

export function isPmsCalendarAutoOpenSetting(value: unknown): value is PmsCalendarAutoOpenSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PmsCalendarAutoOpenSetting>;
  return (
    candidate.contractVersion === PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION &&
    typeof candidate.propertyId === "string" &&
    candidate.propertyId.length > 0 &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision! >= 0 &&
    (candidate.updatedAt === null ||
      (typeof candidate.updatedAt === "string" &&
        Number.isFinite(Date.parse(candidate.updatedAt)))) &&
    isPmsCalendarAutoOpenConfiguration(candidate)
  );
}

export function calculatePmsCalendarAutoOpenHorizon(
  setting: PmsCalendarAutoOpenSetting,
  propertyTimeZone: string,
  instant: Date,
): PmsCalendarAutoOpenHorizon {
  const propertyLocalDate = localDate(instant, propertyTimeZone);
  let targetOpenThrough: string | null = null;
  if (setting.enabled) {
    const [year, month] = propertyLocalDate.split("-").map(Number);
    if (setting.mode === "rolling") {
      targetOpenThrough = monthEnd(year!, month! - 1 + setting.rollingMonths!);
    } else {
      const [fixedYear, fixedMonth] = setting.fixedEndMonth!.split("-").map(Number);
      targetOpenThrough = monthEnd(fixedYear!, fixedMonth! - 1);
    }
  }
  return Object.freeze({ propertyTimeZone, propertyLocalDate, targetOpenThrough });
}

export function isPmsCalendarAutoOpenFixedTargetWithinLimit(
  configuration: PmsCalendarAutoOpenConfiguration,
  propertyTimeZone: string,
  instant: Date,
): boolean {
  if (configuration.mode !== "fixed") return true;
  if (configuration.fixedEndMonth === null) return false;
  const [year, month] = localDate(instant, propertyTimeZone).split("-").map(Number);
  const maximumMonth = monthEnd(year!, month! - 1 + PMS_CALENDAR_AUTO_OPEN_MAX_FIXED_MONTHS).slice(
    0,
    7,
  );
  return configuration.fixedEndMonth <= maximumMonth;
}

export function createPmsCalendarAutoOpenSource(
  input: Omit<PmsCalendarAutoOpenSource, "contractVersion">,
): PmsCalendarAutoOpenSource {
  const rooms = [...input.rooms].sort(byRoomTypeId).map((room) =>
    Object.freeze({
      roomTypeId: room.roomTypeId,
      roomFactsRevision: room.roomFactsRevision,
      roomUnitsRevision: room.roomUnitsRevision,
    }),
  );
  const flexibleRatePlans = [...input.pricing.flexibleRatePlans].sort(byRoomTypeId).map((plan) =>
    Object.freeze({
      roomTypeId: plan.roomTypeId,
      flexibleRatePlanRevision: plan.flexibleRatePlanRevision,
    }),
  );
  assertSource(input, rooms, flexibleRatePlans);
  return Object.freeze({
    contractVersion: PMS_CALENDAR_AUTO_OPEN_SOURCE_CONTRACT_VERSION,
    settingRevision: input.settingRevision,
    propertyProfileRevision: input.propertyProfileRevision,
    propertyTimeZone: input.propertyTimeZone,
    operatingCalendarRevision: input.operatingCalendarRevision,
    rooms: Object.freeze(rooms),
    pricing: Object.freeze({
      pricingCurrencyRevision: input.pricing.pricingCurrencyRevision,
      flexibleRatePlans: Object.freeze(flexibleRatePlans),
      optionalPricingAggregateRevision: input.pricing.optionalPricingAggregateRevision,
    }),
  });
}

export function fingerprintPmsCalendarAutoOpenSource(source: PmsCalendarAutoOpenSource): string {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function byRoomTypeId(left: { roomTypeId: string }, right: { roomTypeId: string }): number {
  return left.roomTypeId < right.roomTypeId ? -1 : left.roomTypeId > right.roomTypeId ? 1 : 0;
}

function assertSource(
  input: Omit<PmsCalendarAutoOpenSource, "contractVersion">,
  rooms: PmsCalendarAutoOpenSource["rooms"],
  plans: PmsCalendarAutoOpenSource["pricing"]["flexibleRatePlans"],
): void {
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
  if (
    !positive(input.settingRevision) ||
    !positive(input.propertyProfileRevision) ||
    !positive(input.operatingCalendarRevision) ||
    input.propertyTimeZone.trim() !== input.propertyTimeZone ||
    input.propertyTimeZone.length === 0 ||
    rooms.length === 0 ||
    rooms.some(
      (room, index) =>
        room.roomTypeId.length === 0 ||
        !positive(room.roomFactsRevision) ||
        !positive(room.roomUnitsRevision) ||
        (index > 0 && rooms[index - 1]!.roomTypeId === room.roomTypeId),
    ) ||
    !positive(input.pricing.pricingCurrencyRevision) ||
    !Number.isSafeInteger(input.pricing.optionalPricingAggregateRevision) ||
    input.pricing.optionalPricingAggregateRevision < 0 ||
    plans.some(
      (plan, index) =>
        plan.roomTypeId.length === 0 ||
        !positive(plan.flexibleRatePlanRevision) ||
        (index > 0 && plans[index - 1]!.roomTypeId === plan.roomTypeId),
    )
  ) {
    throw new TypeError("PMS calendar auto-open source is invalid");
  }
}

function localDate(instant: Date, timeZone: string): string {
  if (!Number.isFinite(instant.valueOf())) throw new Error("Evaluation instant is invalid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const result = `${part("year")}-${part("month")}-${part("day")}`;
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u.test(result))
    throw new Error("Property timezone did not produce a local date");
  return result;
}

function monthEnd(year: number, zeroBasedMonth: number): string {
  return new Date(Date.UTC(year, zeroBasedMonth + 1, 0)).toISOString().slice(0, 10);
}
