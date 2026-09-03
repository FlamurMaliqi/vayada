export const PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION = "pms-calendar-auto-open.v1" as const;
export const PMS_CALENDAR_AUTO_OPEN_ROLLING_MONTHS = [12, 18, 24] as const;

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
}>;

export type PmsCalendarAutoOpenWarning = Readonly<{
  code: "missing_rate";
  roomTypeId: string;
  from: string;
  through: string;
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
