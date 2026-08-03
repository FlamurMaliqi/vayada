import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BOOKING_DESIGN_DEFAULT_FONT_PAIRING,
  BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
  BOOKING_DESIGN_CHANGED_EVENT_TYPE,
  BOOKING_DESIGN_FONT_PAIRINGS,
  BOOKING_DESIGN_OUTBOX_DESTINATION,
  BOOKING_DESIGN_PRIMARY_COLORS,
  createBookingDesignButtonColors,
  createBookingDesignSourceRevision,
  parseBookingDesignRevision,
  parseUpsertBookingDesignRequest,
  serializeBookingDesignCommandFingerprint,
  serializeBookingDesignSourceRevision,
  type BookingDesignChangedEvent,
  type UpsertBookingDesignCommand,
} from "./bookingDesign.js";

const propertyId = "abcdef00-0000-4000-8000-000000000002";

describe("Booking design contract", () => {
  it("resolves explicit server defaults and rejects non-allowlisted choices", () => {
    expect(
      parseUpsertBookingDesignRequest({
        expectedRevision: 0,
        primaryColor: null,
        fontPairing: null,
      }),
    ).toEqual({
      expectedRevision: 0,
      choices: {
        primaryColor: BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
        fontPairing: BOOKING_DESIGN_DEFAULT_FONT_PAIRING,
      },
    });
    expect(BOOKING_DESIGN_PRIMARY_COLORS.join(",")).toBe("#4F46E5,#0077B6,#2D6A4F,#7B2D8E,#2D3436");
    expect(Object.keys(BOOKING_DESIGN_FONT_PAIRINGS).join(",")).toBe(
      "high-end-serif,modern-minimalist,grand-classic,imperial-serif,italiana-serif",
    );
    for (const invalid of [
      { expectedRevision: 2_147_483_647, primaryColor: null, fontPairing: null },
      { expectedRevision: 0, primaryColor: "#D4A017", fontPairing: null },
      { expectedRevision: 0, primaryColor: "#E76F51", fontPairing: null },
      { expectedRevision: 0, primaryColor: "#ffffff", fontPairing: null },
      { expectedRevision: 0, primaryColor: null, fontPairing: "comic-sans" },
      { expectedRevision: 0, primaryColor: undefined, fontPairing: null },
    ])
      expect(parseUpsertBookingDesignRequest(invalid)).toBeNull();
  });

  it("keeps create/upsert revisions strict and immutable in parsed output", () => {
    const mixedCasePropertyId = "ABCDEF00-0000-4000-8000-000000000002";
    const parsed = parseBookingDesignRevision({
      contractVersion: "booking-design.v1",
      propertyId: mixedCasePropertyId,
      revision: 1,
      choices: { primaryColor: "#0077B6", fontPairing: "modern-minimalist" },
      createdAt: "2026-08-03T12:00:00.000Z",
    });
    expect(parsed).toEqual(
      expect.objectContaining({ propertyId: mixedCasePropertyId.toLowerCase(), revision: 1 }),
    );
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.choices)).toBe(true);
    expect(parseBookingDesignRevision({ ...parsed, revision: 0 })).toBeNull();
    expect(parseBookingDesignRevision({ ...parsed, createdAt: "not-a-date" })).toBeNull();
  });

  it("fingerprints logical scope, expected revision, and both choices only", () => {
    const command = (overrides: Partial<UpsertBookingDesignCommand> = {}) =>
      ({
        organizationId: "abcdef10-0000-4000-8000-000000000001",
        propertyId,
        actorUserId: "30000000-0000-4000-8000-000000000003",
        idempotencyKey: "retry-me",
        audit: { requestId: "request-1", source: "api" },
        expectedRevision: 2,
        choices: { primaryColor: "#0077B6", fontPairing: "modern-minimalist" },
        ...overrides,
      }) as UpsertBookingDesignCommand;
    const original = serializeBookingDesignCommandFingerprint(command());
    const caseVariant = command({
      organizationId: command().organizationId.toUpperCase(),
      propertyId: propertyId.toUpperCase(),
    });
    expect(serializeBookingDesignCommandFingerprint(caseVariant)).toBe(original);
    for (const invalidScope of [{ propertyId: "invalid" }, { organizationId: "invalid" }]) {
      expect(() => serializeBookingDesignCommandFingerprint(command(invalidScope))).toThrow();
    }
    const reorderedChoices = {
      fontPairing: "modern-minimalist",
      primaryColor: "#0077B6",
      ignored: true,
    } as UpsertBookingDesignCommand["choices"];
    expect(serializeBookingDesignCommandFingerprint(command({ choices: reorderedChoices }))).toBe(
      original,
    );
    expect(
      serializeBookingDesignCommandFingerprint(
        command({
          actorUserId: "40000000-0000-4000-8000-000000000004",
          idempotencyKey: "another-key",
          audit: { requestId: "request-2", source: "worker" },
        }),
      ),
    ).toBe(original);
    expect(serializeBookingDesignCommandFingerprint(command({ expectedRevision: 3 }))).not.toBe(
      original,
    );
    expect(
      serializeBookingDesignCommandFingerprint(
        command({
          choices: { primaryColor: "#2D6A4F", fontPairing: "modern-minimalist" },
        }),
      ),
    ).not.toBe(original);
  });

  it("owns stable source and secret-safe event vocabulary", () => {
    const mixedCasePropertyId = "ABCDEF00-0000-4000-8000-000000000002";
    const source = createBookingDesignSourceRevision(mixedCasePropertyId, 3);
    if (false) {
      // @ts-expect-error Booking source identity is immutable.
      source.entityId = propertyId;
    }
    expect(source).toEqual({
      ownerDomain: "booking",
      entityType: "design_revision",
      entityId: mixedCasePropertyId.toLowerCase(),
      revision: "design:3",
    });
    expect(createBookingDesignSourceRevision(mixedCasePropertyId, 4).entityId).toBe(
      source.entityId,
    );
    expect(serializeBookingDesignSourceRevision(2_147_483_647)).toBe("design:2147483647");
    expect(() => serializeBookingDesignSourceRevision(0)).toThrow();
    expect(() => serializeBookingDesignSourceRevision(2_147_483_648)).toThrow();
    expect(BOOKING_DESIGN_CHANGED_EVENT_TYPE).toBe("booking.design.changed");
    expect(BOOKING_DESIGN_OUTBOX_DESTINATION).toBe("booking.launch-readiness");
    expectTypeOf<BookingDesignChangedEvent>().not.toHaveProperty("choices");
  });

  it("keeps every generated Booking button palette WCAG AA-safe with white text", () => {
    const rendererFixtures = {
      "#4F46E5": ["#463eca", "#3932a5"],
      "#0077B6": ["#0069a0", "#005683"],
      "#2D6A4F": ["#285d46", "#204c39"],
      "#7B2D8E": ["#6c287d", "#592066"],
      "#2D3436": ["#282e30", "#202527"],
    } as const;
    for (const primaryColor of BOOKING_DESIGN_PRIMARY_COLORS) {
      const button = createBookingDesignButtonColors(primaryColor);
      expect([button.backgroundColor, button.hoverBackgroundColor]).toEqual(
        rendererFixtures[primaryColor],
      );
      expect(contrastWithWhite(button.backgroundColor), primaryColor).toBeGreaterThanOrEqual(4.5);
      expect(contrastWithWhite(button.hoverBackgroundColor), primaryColor).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(button.foregroundColor).toBe("#FFFFFF");
    }
  });
});

function contrastWithWhite(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const luminance = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 1.05 / (0.2126 * luminance[0]! + 0.7152 * luminance[1]! + 0.0722 * luminance[2]! + 0.05);
}
