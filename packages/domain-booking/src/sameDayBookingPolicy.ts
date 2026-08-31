export const SAME_DAY_BOOKING_POLICY_CONTRACT_VERSION = "same-day-booking-policy.v1" as const;
export const SAME_DAY_BOOKING_POLICY_DEFAULTS = Object.freeze({
  enabled: true,
  cutoffLocalTime: "18:00",
});

export type SameDayBookingPolicy = Readonly<{
  enabled: boolean;
  cutoffLocalTime: string | null;
}>;

export type SameDayBookingDecision = Readonly<{
  eligible: boolean;
  reason: "not_same_day" | "before_cutoff" | "same_day_disabled" | "cutoff_passed";
  currentLocalDate: string;
  currentLocalTime: string;
}>;

export function evaluateSameDayBooking(input: {
  checkIn: string;
  policy: SameDayBookingPolicy;
  propertyTimeZone: string;
  now: Date;
}): SameDayBookingDecision {
  if (!localDate(input.checkIn)) throw new Error("checkIn must be a local date");
  if (!Number.isFinite(input.now.valueOf())) throw new Error("now must be a valid instant");
  const cutoff = input.policy.cutoffLocalTime;
  if (cutoff !== null && !halfHourTime(cutoff))
    throw new Error("cutoffLocalTime must be HH:mm on a 30-minute boundary or null");

  const local = propertyClock(input.now, input.propertyTimeZone);
  if (input.checkIn !== local.date) return decision(true, "not_same_day", local.date, local.time);
  if (!input.policy.enabled) return decision(false, "same_day_disabled", local.date, local.time);
  if (cutoff === null || local.time < cutoff)
    return decision(true, "before_cutoff", local.date, local.time);
  return decision(false, "cutoff_passed", local.date, local.time);
}

function propertyClock(now: Date, timeZone: string): { date: string; time: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    throw new Error("propertyTimeZone must be a valid IANA timezone");
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

function decision(
  eligible: boolean,
  reason: SameDayBookingDecision["reason"],
  currentLocalDate: string,
  currentLocalTime: string,
): SameDayBookingDecision {
  return { eligible, reason, currentLocalDate, currentLocalTime };
}

function localDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

function halfHourTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):(?:00|30)$/.test(value);
}
