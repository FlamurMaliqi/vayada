export function collaborationToday(
  timezone: string | null | undefined,
  now = new Date(),
): string | null {
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return null;
  }
}

export function collaborationDateError(
  from: string | null | undefined,
  to: string | null | undefined,
  today: string | null,
): string | null {
  if (!today)
    return "Collaboration availability is unavailable until the property timezone is configured.";
  if ((from && from < today) || (to && to < today))
    return "Collaboration dates cannot be in the past.";
  if (
    !from ||
    !to ||
    ![from, to].every(
      (value) =>
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString().slice(0, 10) === value,
    )
  )
    return "Select valid collaboration start and end dates.";
  if (to <= from) return "The end date must be after the start date.";
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function collaborationAvailabilityError(
  months: readonly string[],
  today: string | null,
): string | null {
  if (!today || months.length === 0) return null;
  const currentMonth = Number(today.slice(5, 7)) - 1;
  return months.some(
    (month) => MONTHS.indexOf(month.trim().slice(0, 3).toLowerCase()) >= currentMonth,
  )
    ? null
    : "This offering has no remaining availability this year. Please choose another offering.";
}
