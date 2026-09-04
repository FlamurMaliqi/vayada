import type { InboxReplyRoute, InboxThread } from "@/services/messaging";

export function inboxGuestName(thread: Pick<InboxThread, "guest">): string {
  return thread.guest.displayName?.trim() || "Unknown guest";
}

export function inboxSourceLabel(thread: Pick<InboxThread, "channel" | "providerChannel">): string {
  if (thread.channel === "email") return "Email";
  switch (thread.providerChannel?.toLowerCase().replaceAll("_", "")) {
    case "booking.com":
    case "bookingcom":
      return "Booking.com";
    case "airbnb":
      return "Airbnb";
    default:
      return thread.providerChannel?.trim() || "OTA";
  }
}

export function inboxContextLabel(thread: Pick<InboxThread, "conversationContext">): string {
  const context = thread.conversationContext;
  if (context.state === "linked") return context.reference;
  if (context.state === "inquiry") return `Inquiry · ${context.sourceReference}`;
  return context.sourceReference
    ? `Unlinked · ${context.sourceReference}`
    : "Unlinked conversation";
}

export function inboxPreview(thread: Pick<InboxThread, "lastMessage">): string {
  if (!thread.lastMessage.at) return "No messages yet";
  if (thread.lastMessage.preview?.trim()) return thread.lastMessage.preview.trim();
  return thread.lastMessage.hasAttachments ? "Attachment" : "Message unavailable";
}

export function inboxRouteLabel(route: InboxReplyRoute): string {
  if (route.state === "ready") {
    return route.channel === "email"
      ? "Replying by email"
      : `Replying through ${providerLabel(route.providerChannel)}`;
  }
  return `Reply unavailable · ${heldRouteReason(route.reasonCode)}`;
}

export function heldRouteReason(
  reason: Extract<InboxReplyRoute, { state: "held" }>["reasonCode"],
): string {
  switch (reason) {
    case "channel_connection_inactive":
      return "channel connection is inactive";
    case "provider_conversation_unavailable":
      return "provider conversation is unavailable";
    case "guest_email_unavailable":
      return "guest email is unavailable";
    case "approved_sender_unavailable":
      return "approved sender is unavailable";
    case "email_policy_disallowed":
      return "email policy does not allow this reply";
  }
}

export function formatInboxTime(value: string, now = new Date()): string {
  const date = new Date(value);
  const difference = now.getTime() - date.getTime();
  if (!Number.isFinite(difference)) return "";
  const minutes = Math.max(0, Math.floor(difference / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  if (hours < 24 * 7) return `${Math.floor(hours / 24)}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatInboxDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function formatInboxDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatPropertyDateTimeInput(date: Date, timeZone: string): string | null {
  const parts = dateTimeParts(date, timeZone);
  if (!parts) return null;
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function propertyLocalDateTimeToIso(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const wallTime = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  if (!Number.isFinite(wallTime)) return null;

  let instant = wallTime;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = dateTimeParts(new Date(instant), timeZone);
    if (!parts) return null;
    const representedWallTime = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );
    const corrected = wallTime - (representedWallTime - instant);
    if (corrected === instant) break;
    instant = corrected;
  }

  const date = new Date(instant);
  return formatPropertyDateTimeInput(date, timeZone) === value ? date.toISOString() : null;
}

function dateTimeParts(date: Date, timeZone: string) {
  try {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(date)
        .filter(({ type }) => type !== "literal")
        .map(({ type, value }) => [type, Number(value)]),
    );
    if ([values.year, values.month, values.day, values.hour, values.minute].some(Number.isNaN)) {
      return null;
    }
    return values as Record<"year" | "month" | "day" | "hour" | "minute", number>;
  } catch {
    return null;
  }
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function providerLabel(providerChannel: string | null): string {
  return inboxSourceLabel({ channel: "ota", providerChannel });
}
