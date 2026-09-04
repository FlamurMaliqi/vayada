export type GoogleHotelStay = { checkIn: string; checkOut: string };
export type GoogleHotelTrafficSource = "Google Free Booking Links" | "Google Hotel Ads";

const TRAFFIC_SOURCE_KEY = "vayada_google_hotel_traffic_source";

export function googleHotelStay(
  searchParams: Pick<URLSearchParams, "get" | "has">,
  today = new Date(),
): GoogleHotelStay | null {
  if (!searchParams.has("checkin") && !searchParams.has("nights")) return null;
  const checkIn = searchParams.get("checkin") ?? "";
  const nightsValue = searchParams.get("nights") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d+$/.test(nightsValue)) return null;
  const nights = Number(nightsValue);
  if (!Number.isSafeInteger(nights) || nights < 1 || nights > 365) return null;

  const checkInDate = new Date(`${checkIn}T00:00:00Z`);
  if (Number.isNaN(checkInDate.getTime()) || checkInDate.toISOString().slice(0, 10) !== checkIn) {
    return null;
  }
  if (checkIn < localDate(today)) return null;
  checkInDate.setUTCDate(checkInDate.getUTCDate() + nights);
  return { checkIn, checkOut: checkInDate.toISOString().slice(0, 10) };
}

export function googleHotelTrafficSource(
  searchParams: Pick<URLSearchParams, "get" | "has">,
  referrer: string,
): GoogleHotelTrafficSource | null {
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  const googleHost = url.hostname === "google.com" || url.hostname.endsWith(".google.com");
  const hotelPath =
    url.pathname === "/travel" ||
    url.pathname.startsWith("/travel/") ||
    url.pathname === "/hotels" ||
    url.pathname.startsWith("/hotels/");
  const hasLandingParameters = searchParams.has("checkin") && searchParams.has("nights");
  if (!googleHost || (!hotelPath && !hasLandingParameters)) return null;
  return searchParams.has("gclid") || searchParams.get("utm_medium") === "cpc"
    ? "Google Hotel Ads"
    : "Google Free Booking Links";
}

export function rememberGoogleHotelTrafficSource(source: GoogleHotelTrafficSource | null) {
  if (typeof sessionStorage === "undefined" || !source) return;
  sessionStorage.setItem(TRAFFIC_SOURCE_KEY, source);
}

export function storedGoogleHotelTrafficSource(): GoogleHotelTrafficSource | undefined {
  if (typeof sessionStorage === "undefined") return undefined;
  const source = sessionStorage.getItem(TRAFFIC_SOURCE_KEY);
  return source === "Google Free Booking Links" || source === "Google Hotel Ads"
    ? source
    : undefined;
}

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
