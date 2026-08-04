import { describe, expect, it } from "vitest";

import {
  PMS_OPERATING_CALENDAR_IMPACT_CONFIRMATION_TTL_SECONDS,
  parsePmsOperatingCalendarImpactPreview,
  parsePmsOperatingCalendarImpactPreviewError,
  parsePmsOperatingCalendarImpactPreviewRequest,
  parsePmsOperatingCalendarImpactPreviewResult,
  parsePmsOperatingCalendarUpsertRequest,
  parsePreviewPmsOperatingCalendarImpactCommand,
} from "./index.js";

const organizationId = "a7100000-0000-4000-8000-000000000001";
const propertyId = "a7100000-0000-4000-8000-000000000002";
const roomTypeId = "a7100000-0000-4000-8000-000000000003";
const actorUserId = "a7100000-0000-4000-8000-000000000004";
const generatedAt = "2026-08-04T12:00:00.000Z";
const expiresAt = "2026-08-04T12:15:00.000Z";

describe("PMS operating-calendar impact contract", () => {
  it("parses and canonicalizes an exact preview proposal without confirmation transport", () => {
    const parsed = parsePreviewPmsOperatingCalendarImpactCommand(command());
    expect(parsed).toMatchObject({
      organizationId,
      propertyId,
      expectedCalendarRevision: 3,
      roomTypeLimits: [{ roomTypeId }],
    });
    expect(
      parsePreviewPmsOperatingCalendarImpactCommand({
        ...command(),
        impactConfirmation: confirmation(),
      }),
    ).toBeNull();
  });

  it("exports exact browser request, success, error, and final PUT parsers", () => {
    const {
      organizationId: _organization,
      propertyId: _property,
      audit: _audit,
      ...request
    } = command();
    expect(parsePmsOperatingCalendarImpactPreviewRequest(request)).toEqual(request);
    expect(parsePmsOperatingCalendarImpactPreviewRequest({ ...request, propertyId })).toBeNull();
    expect(parsePmsOperatingCalendarImpactPreview(previewResult().preview)).toEqual(
      previewResult().preview,
    );
    expect(
      parsePmsOperatingCalendarImpactPreviewError({
        code: "room_capacity_unavailable",
        roomTypeId,
      }),
    ).toEqual({ code: "room_capacity_unavailable", roomTypeId });
    expect(
      parsePmsOperatingCalendarImpactPreviewError({ code: "materialization_not_current" }),
    ).toEqual({ code: "materialization_not_current" });
    expect(
      parsePmsOperatingCalendarUpsertRequest({ ...request, impactConfirmation: confirmation() }),
    ).toEqual({ ...request, impactConfirmation: confirmation() });
  });

  it("round-trips only sorted public-safe aggregates and complete source fingerprints", () => {
    expect(PMS_OPERATING_CALENDAR_IMPACT_CONFIRMATION_TTL_SECONDS).toBe(900);
    const result = previewResult();
    expect(parsePmsOperatingCalendarImpactPreviewResult(result)).toEqual(result);

    const leaked = structuredClone(result);
    (leaked as Record<string, any>).preview.impact.affectedDates[0].guestName = "Private Guest";
    expect(parsePmsOperatingCalendarImpactPreviewResult(leaked)).toBeNull();
  });

  it("fails closed on cross-evidence fingerprints, malformed coverage, and unsorted impacts", () => {
    const mismatched = structuredClone(previewResult());
    mismatched.preview.confirmation.sourceFingerprint = "9".repeat(64);
    expect(parsePmsOperatingCalendarImpactPreviewResult(mismatched)).toBeNull();

    const malformedCoverage = structuredClone(previewResult());
    (
      malformedCoverage.preview.sourceRevisions.inventory as { coverageThrough: string | null }
    ).coverageThrough = null;
    expect(parsePmsOperatingCalendarImpactPreviewResult(malformedCoverage)).toBeNull();

    const unsorted = structuredClone(previewResult());
    unsorted.preview.impact.categories.reverse();
    expect(parsePmsOperatingCalendarImpactPreviewResult(unsorted)).toBeNull();
  });

  it("parses the complete source conflict vocabulary without widening errors", () => {
    expect(
      parsePmsOperatingCalendarImpactPreviewResult({
        ok: false,
        error: { code: "room_units_revision_conflict", roomTypeId, currentRevision: 4 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "room_units_revision_conflict", roomTypeId, currentRevision: 4 },
    });
    expect(
      parsePmsOperatingCalendarImpactPreviewResult({
        ok: false,
        error: { code: "booking_private_detail", guestName: "Private Guest" },
      }),
    ).toBeNull();
  });
});

function command() {
  return {
    organizationId,
    propertyId,
    expectedCalendarRevision: 3,
    expectedPropertyProfileRevision: 7,
    schedule: { mode: "recurring", periods: [{ startsOn: "04-01", endsOn: "10-31" }] },
    defaultMinimumStayNights: 2,
    roomTypeLimits: [
      {
        roomTypeId,
        expectedRoomFactsRevision: 5,
        expectedRoomUnitsRevision: 6,
        startingSellableLimitCount: 2,
      },
    ],
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: "request-impact",
      correlationId: "correlation-impact",
      requestedAt: generatedAt,
    },
  };
}

function confirmation() {
  return {
    contractVersion: "pms-operating-calendar-impact.v1" as const,
    proposalFingerprint: "1".repeat(64),
    sourceFingerprint: "2".repeat(64),
    token: "signed-token",
    issuedAt: generatedAt,
    expiresAt,
  };
}

function previewResult() {
  return {
    ok: true as const,
    preview: {
      contractVersion: "pms-operating-calendar-impact.v1" as const,
      propertyId,
      proposalFingerprint: "1".repeat(64),
      sourceFingerprint: "2".repeat(64),
      sourceRevisions: {
        calendarRevision: 3,
        propertyProfile: { revision: 7, timeZone: "Europe/Berlin" },
        roomTypes: [
          {
            roomTypeId,
            roomFactsRevision: 5,
            roomUnitsRevision: 6,
            physicalCapacityCount: 3,
          },
        ],
        inventory: {
          materializedRevision: 3,
          coverageFrom: "2026-08-04",
          coverageThrough: "2027-08-04",
          dayCount: 366,
          inventoryFingerprint: "3".repeat(64),
          bookingFingerprint: "4".repeat(64),
          blockFingerprint: "5".repeat(64),
          overrideFingerprint: "6".repeat(64),
          activeReservationCount: 2,
        },
      },
      impact: {
        categories: [
          "accepted_bookings_on_closing_dates" as const,
          "operating_dates_close" as const,
        ],
        summary: {
          closingDateCount: 1,
          openingDateCount: 0,
          availableRoomNightsRemoved: 1,
          availableRoomNightsAdded: 0,
          acceptedBookingCount: 1,
          acceptedBookedRoomNights: 1,
          blockedRoomNights: 0,
          ownerOverrideDateCount: 0,
          defaultMinimumStayChanged: false,
        },
        affectedDates: [
          {
            stayDate: "2026-11-01",
            statusChange: "open_to_closed" as const,
            availableCountBefore: 1,
            availableCountAfter: 0,
            assignedCount: 1,
            blockedCount: 0,
            acceptedBookingCount: 1,
            ownerOverridePresent: false,
          },
        ],
        roomTypeChanges: [
          {
            roomTypeId,
            previousStartingSellableLimitCount: 3,
            proposedStartingSellableLimitCount: 2,
            availableRoomNightsDelta: -1,
          },
        ],
      },
      confirmation: confirmation(),
      generatedAt,
    },
  };
}
