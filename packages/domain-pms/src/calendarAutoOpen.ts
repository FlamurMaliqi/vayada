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

export const PMS_CALENDAR_AUTO_OPEN_DEFAULT_CONFIGURATION = Object.freeze({
  enabled: false,
  mode: "rolling",
  rollingMonths: 18,
  fixedEndMonth: null,
} satisfies PmsCalendarAutoOpenConfiguration);

export type UpdatePmsCalendarAutoOpenSetting = PmsCalendarAutoOpenConfiguration &
  Readonly<{ propertyId: string; expectedRevision: number }>;

export type PmsCalendarAutoOpenUpdateResult =
  | Readonly<{
      ok: true;
      outcome: "created" | "updated" | "unchanged";
      setting: PmsCalendarAutoOpenSetting;
    }>
  | Readonly<{
      ok: false;
      error:
        | Readonly<{
            code: "invalid_setting" | "property_not_found" | "property_time_zone_invalid";
          }>
        | Readonly<{ code: "calendar_auto_open_revision_conflict"; currentRevision: number }>;
    }>;

export type PmsCalendarAutoOpenSettingsPort = {
  find(propertyId: string): Promise<PmsCalendarAutoOpenSetting | null>;
  update(command: UpdatePmsCalendarAutoOpenSetting): Promise<PmsCalendarAutoOpenUpdateResult>;
};

const FIXED_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/u;

export function isPmsCalendarAutoOpenConfiguration(
  value: PmsCalendarAutoOpenConfiguration,
): boolean {
  if (typeof value.enabled !== "boolean") return false;
  if (value.mode === "rolling")
    return (
      PMS_CALENDAR_AUTO_OPEN_ROLLING_MONTHS.includes(value.rollingMonths as 12 | 18 | 24) &&
      value.fixedEndMonth === null
    );
  if (value.mode !== "fixed" || value.rollingMonths !== null) return false;
  const match = value.fixedEndMonth === null ? null : FIXED_MONTH.exec(value.fixedEndMonth);
  return match !== null && Number(match[1]) > 0;
}
