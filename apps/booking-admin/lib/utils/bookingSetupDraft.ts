const BOOKING_SETUP_DRAFT_VERSION = 2 as const;
const BOOKING_SETUP_DRAFT_PREFIX = "booking-setup:draft:v2:";
export const BOOKING_SETUP_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export type BookingSetupDraftScope = {
  userId: string;
  organizationId: string;
  propertyId?: string | null;
};

export type BookingSetupDraft = {
  version: typeof BOOKING_SETUP_DRAFT_VERSION;
  step: number;
  values: Record<string, unknown>;
  savedAt: string;
};

export function bookingSetupDraftKey(scope: BookingSetupDraftScope): string {
  const userId = requiredScopeValue(scope.userId, "user id");
  const organizationId = requiredScopeValue(scope.organizationId, "organization id");
  const propertyId = scope.propertyId?.trim() || "new-property";
  const scopeKey = [userId, organizationId, propertyId]
    .map((value) => encodeURIComponent(value))
    .join(":");
  return `${BOOKING_SETUP_DRAFT_PREFIX}${scopeKey}`;
}

export function readBookingSetupDraft(
  storage: Pick<Storage, "getItem" | "removeItem">,
  scope: BookingSetupDraftScope,
  now = Date.now(),
): BookingSetupDraft | null {
  const key = bookingSetupDraftKey(scope);
  const raw = storage.getItem(key);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== BOOKING_SETUP_DRAFT_VERSION) {
      return discardDraft(storage, key);
    }
    if (!Number.isInteger(parsed.step) || Number(parsed.step) < 1) {
      return discardDraft(storage, key);
    }
    if (!isRecord(parsed.values) || typeof parsed.savedAt !== "string") {
      return discardDraft(storage, key);
    }
    const savedAt = Date.parse(parsed.savedAt);
    if (!Number.isFinite(savedAt) || now - savedAt >= BOOKING_SETUP_DRAFT_MAX_AGE_MS) {
      return discardDraft(storage, key);
    }
    return parsed as BookingSetupDraft;
  } catch {
    return discardDraft(storage, key);
  }
}

export function writeBookingSetupDraft(
  storage: Pick<Storage, "setItem">,
  scope: BookingSetupDraftScope,
  input: { step: number; values: Record<string, unknown> },
  now = Date.now(),
): void {
  const sanitized = sanitizeSerializable(input.values);
  const values = isRecord(sanitized) ? sanitized : {};
  const draft: BookingSetupDraft = {
    version: BOOKING_SETUP_DRAFT_VERSION,
    step: Number.isInteger(input.step) && input.step > 0 ? input.step : 1,
    values,
    savedAt: new Date(now).toISOString(),
  };
  storage.setItem(bookingSetupDraftKey(scope), JSON.stringify(draft));
}

export function clearBookingSetupDraft(
  storage: Pick<Storage, "removeItem">,
  scope: BookingSetupDraftScope,
): void {
  storage.removeItem(bookingSetupDraftKey(scope));
}

function requiredScopeValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Booking setup draft ${label} is required.`);
  return normalized;
}

function discardDraft(storage: Pick<Storage, "removeItem">, key: string): null {
  storage.removeItem(key);
  return null;
}

function sanitizeSerializable(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.startsWith("blob:") ? undefined : value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSerializable(item)).filter((item) => item !== undefined);
  }
  if (!isRecord(value)) return undefined;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const sanitized = sanitizeSerializable(child);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
