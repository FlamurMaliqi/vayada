export function calendarDatesInRange(start: string, end: string): string[] {
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const exclusiveEnd = new Date(`${end}T00:00:00.000Z`);
  const dates: string[] = [];

  while (cursor < exclusiveEnd) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}
