// Arrival restrictions match the target checkout quote: one offer for every
// occupied night, with min/max stay taken from the arrival date.
export type CalendarStayDay = {
  stayDate: string;
  hasAvailability: boolean;
  offers?: { key: string; min: number; max: number | null }[];
};

export function calendarStays(days: CalendarStayDay[], end: string) {
  const validCheckOutsByArrival: Record<string, string[]> = {};
  const minStayByArrival: Record<string, number> = {};
  let nextDate = end;
  let nextRuns = new Map<string, number>();
  // Walk backwards once per offer, then union intervals before enumerating dates.
  for (const arrival of [...days].sort((a, b) => b.stayDate.localeCompare(a.stayDate))) {
    const timestamp = Date.parse(`${arrival.stayDate}T00:00:00Z`);
    const dateAfter = (nights: number) =>
      new Date(timestamp + nights * 86400000).toISOString().slice(0, 10);
    if (dateAfter(1) !== nextDate) nextRuns.clear();
    const offers = arrival.hasAvailability ? (arrival.offers ?? []) : [];
    const runs = new Map(offers.map((offer) => [offer.key, 1 + (nextRuns.get(offer.key) ?? 0)]));
    const intervals = offers
      .map((offer): [number, number] => [
        offer.min,
        Math.min(offer.max ?? Infinity, runs.get(offer.key)!),
      ])
      .filter(([minimum, maximum]) => minimum <= maximum)
      .sort((a, b) => a[0] - b[0]);
    const valid: string[] = [];
    let lastNight = 0;
    for (const [minimum, maximum] of intervals) {
      for (let nights = Math.max(minimum, lastNight + 1); nights <= maximum; nights++) {
        const checkout = dateAfter(nights);
        if (checkout <= end) valid.push(checkout);
      }
      lastNight = Math.max(lastNight, maximum);
    }
    validCheckOutsByArrival[arrival.stayDate] = valid;
    if (offers.length) {
      minStayByArrival[arrival.stayDate] = valid[0]
        ? Math.round((Date.parse(valid[0]) - timestamp) / 86400000)
        : Math.min(...offers.map((offer) => offer.min));
    }
    nextDate = arrival.stayDate;
    nextRuns = runs;
  }
  return { validCheckOutsByArrival, minStayByArrival };
}
