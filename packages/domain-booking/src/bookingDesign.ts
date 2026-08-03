import type { SourceEntityRevision } from "@vayada/domain-hotels";

export const BOOKING_DESIGN_CONTRACT_VERSION = "booking-design.v1" as const;
export const BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR = "#4F46E5" as const;
export const BOOKING_DESIGN_BUTTON_FOREGROUND_COLOR = "#FFFFFF" as const;
export const BOOKING_DESIGN_PRIMARY_COLORS = Object.freeze([
  BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
  "#0077B6",
  "#2D6A4F",
  "#7B2D8E",
  "#2D3436",
] as const);
export const BOOKING_DESIGN_DEFAULT_FONT_PAIRING = "high-end-serif" as const;
export const BOOKING_DESIGN_SOURCE_OWNER_DOMAIN = "booking" as const;
export const BOOKING_DESIGN_SOURCE_ENTITY_TYPE = "design_revision" as const;
export const BOOKING_DESIGN_CHANGED_EVENT_TYPE = "booking.design.changed" as const;
export const BOOKING_DESIGN_OUTBOX_DESTINATION = "booking.launch-readiness" as const;
export const BOOKING_DESIGN_FONT_PAIRINGS = Object.freeze({
  "high-end-serif": Object.freeze({
    headingFamily: "'Playfair Display', serif",
    bodyFamily: "'Source Sans Pro', sans-serif",
  }),
  "modern-minimalist": Object.freeze({
    headingFamily: "'Inter', sans-serif",
    bodyFamily: "'Inter', sans-serif",
  }),
  "grand-classic": Object.freeze({
    headingFamily: "'Lora', serif",
    bodyFamily: "'Source Sans Pro', sans-serif",
  }),
  "imperial-serif": Object.freeze({
    headingFamily: "'Cinzel', serif",
    bodyFamily: "'Source Sans Pro', sans-serif",
  }),
  "italiana-serif": Object.freeze({
    headingFamily: "'Italiana', serif",
    bodyFamily: "'Source Sans Pro', sans-serif",
  }),
} as const);

export type BookingDesignPrimaryColor = (typeof BOOKING_DESIGN_PRIMARY_COLORS)[number];
export type BookingDesignFontPairing = keyof typeof BOOKING_DESIGN_FONT_PAIRINGS;
export type BookingDesignSourceRevision = Readonly<
  SourceEntityRevision & {
    ownerDomain: typeof BOOKING_DESIGN_SOURCE_OWNER_DOMAIN;
    entityType: typeof BOOKING_DESIGN_SOURCE_ENTITY_TYPE;
  }
>;
export type BookingDesignChoices = Readonly<{
  primaryColor: BookingDesignPrimaryColor;
  fontPairing: BookingDesignFontPairing;
}>;
export type UpsertBookingDesignRequest = Readonly<{
  expectedRevision: number;
  choices: BookingDesignChoices;
}>;
export type BookingDesignRevision = Readonly<{
  contractVersion: typeof BOOKING_DESIGN_CONTRACT_VERSION;
  propertyId: string;
  revision: number;
  choices: BookingDesignChoices;
  createdAt: string;
}>;
export type BookingDesignCommandAudit = Readonly<{
  requestId: string;
  correlationId?: string;
  source: string;
}>;
export type UpsertBookingDesignCommand = Readonly<{
  organizationId: string;
  propertyId: string;
  actorUserId: string;
  idempotencyKey: string;
  audit: BookingDesignCommandAudit;
  expectedRevision: number;
  choices: BookingDesignChoices;
}>;
export type BookingDesignCommandError =
  | { code: "design_revision_conflict"; currentRevision: number }
  | { code: "command_in_progress" | "idempotency_key_conflict" | "setup_scope_unavailable" };
export type BookingDesignCommandResult =
  | {
      ok: true;
      outcome: "created" | "updated" | "idempotent_replay";
      design: BookingDesignRevision;
    }
  | { ok: false; error: BookingDesignCommandError };
/** Secret-safe invalidation signal; consumers reload the private revision through a typed port. */
export type BookingDesignChangedEvent = Readonly<{
  contractVersion: typeof BOOKING_DESIGN_CONTRACT_VERSION;
  eventType: typeof BOOKING_DESIGN_CHANGED_EVENT_TYPE;
  propertyId: string;
  designRevision: number;
  outcome: "created" | "updated";
}>;
export interface BookingDesignCommandPort {
  /**
   * Composition reauthorizes before every call, including replay. Implementations recheck scope
   * under lock, return changed-key conflict before stale-revision conflict, and atomically commit
   * each new revision with audit, domain event, outbox event, and idempotency result. Exact replay
   * returns the stored design projected as idempotent_replay and emits nothing.
   */
  upsertDesign(command: UpsertBookingDesignCommand): Promise<BookingDesignCommandResult>;
}
export interface BookingDesignReadPort {
  getCurrentDesign(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<BookingDesignRevision | null>;
}

export function parseUpsertBookingDesignRequest(value: unknown): UpsertBookingDesignRequest | null {
  if (!exact(value, ["expectedRevision", "primaryColor", "fontPairing"])) return null;
  const expectedRevision = value["expectedRevision"];
  const primaryColor =
    value["primaryColor"] === null ? BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR : value["primaryColor"];
  const fontPairing =
    value["fontPairing"] === null ? BOOKING_DESIGN_DEFAULT_FONT_PAIRING : value["fontPairing"];
  if (
    !revision(expectedRevision, true) ||
    expectedRevision === 2_147_483_647 ||
    !BOOKING_DESIGN_PRIMARY_COLORS.includes(primaryColor as BookingDesignPrimaryColor) ||
    !Object.hasOwn(BOOKING_DESIGN_FONT_PAIRINGS, fontPairing as PropertyKey)
  ) {
    return null;
  }
  return Object.freeze({
    expectedRevision,
    choices: Object.freeze({ primaryColor, fontPairing }),
  }) as UpsertBookingDesignRequest;
}

export function parseBookingDesignRevision(value: unknown): BookingDesignRevision | null {
  if (
    !exact(value, ["contractVersion", "propertyId", "revision", "choices", "createdAt"]) ||
    value["contractVersion"] !== BOOKING_DESIGN_CONTRACT_VERSION ||
    !uuid(value["propertyId"]) ||
    !revision(value["revision"], false) ||
    !exact(value["choices"], ["primaryColor", "fontPairing"]) ||
    !BOOKING_DESIGN_PRIMARY_COLORS.includes(
      value["choices"]["primaryColor"] as BookingDesignPrimaryColor,
    ) ||
    !Object.hasOwn(BOOKING_DESIGN_FONT_PAIRINGS, value["choices"]["fontPairing"] as PropertyKey) ||
    !iso(value["createdAt"])
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: value["contractVersion"],
    propertyId: value["propertyId"].toLowerCase(),
    revision: value["revision"],
    choices: Object.freeze({
      primaryColor: value["choices"]["primaryColor"],
      fontPairing: value["choices"]["fontPairing"],
    }),
    createdAt: value["createdAt"],
  }) as BookingDesignRevision;
}

export function serializeBookingDesignCommandFingerprint(
  command: UpsertBookingDesignCommand,
): string {
  if (!uuid(command.organizationId) || !uuid(command.propertyId)) {
    throw new Error("Booking design command scope is invalid");
  }
  return JSON.stringify({
    organizationId: command.organizationId.toLowerCase(),
    propertyId: command.propertyId.toLowerCase(),
    expectedRevision: command.expectedRevision,
    choices: {
      primaryColor: command.choices.primaryColor,
      fontPairing: command.choices.fontPairing,
    },
  });
}

export function serializeBookingDesignSourceRevision(designRevision: number): string {
  if (!revision(designRevision, false)) throw new Error("Booking design revision is invalid");
  return `design:${designRevision}`;
}

export function createBookingDesignSourceRevision(
  propertyId: string,
  designRevision: number,
): BookingDesignSourceRevision {
  if (!uuid(propertyId)) throw new Error("Booking design property ID is invalid");
  return Object.freeze({
    ownerDomain: BOOKING_DESIGN_SOURCE_OWNER_DOMAIN,
    entityType: BOOKING_DESIGN_SOURCE_ENTITY_TYPE,
    entityId: propertyId.toLowerCase(),
    revision: serializeBookingDesignSourceRevision(designRevision),
  });
}

/** Matches Booking Web's primary-600/default and primary-700/hover palette tokens. */
export function createBookingDesignButtonColors(primaryColor: BookingDesignPrimaryColor) {
  return Object.freeze({
    backgroundColor: mixWithBlack(primaryColor, 0.12),
    hoverBackgroundColor: mixWithBlack(primaryColor, 0.28),
    foregroundColor: BOOKING_DESIGN_BUTTON_FOREGROUND_COLOR,
  });
}

function mixWithBlack(hex: string, amount: number): string {
  const component = (offset: number) =>
    Math.round(Number.parseInt(hex.slice(offset, offset + 2), 16) * (1 - amount))
      .toString(16)
      .padStart(2, "0");
  return `#${component(1)}${component(3)}${component(5)}`;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    })
  );
}
function revision(value: unknown, zero: boolean): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= (zero ? 0 : 1) &&
    (value as number) <= 2_147_483_647
  );
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
function iso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
