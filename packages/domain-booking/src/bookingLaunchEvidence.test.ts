import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BOOKING_LAUNCH_READINESS_GROUPS,
  BOOKING_LAUNCH_SOURCE_DOMAIN_BY_PORT,
  type BookingLaunchCatalogEvidencePort,
  type BookingLaunchConfigurationEvidencePort,
  type BookingLaunchFinanceEvidencePort,
  type BookingLaunchOwnerEvidenceResult,
  type BookingLaunchPmsEvidencePort,
  type BookingLaunchReadinessProviderPort,
  type BookingLaunchSourceBinding,
  type BookingLaunchSourceOwnerDomain,
} from "./bookingLaunchEvidence.js";

describe("Booking launch owner-evidence contract", () => {
  it("assigns every Booking readiness group to one owner port and setup step", () => {
    expect(BOOKING_LAUNCH_READINESS_GROUPS).toEqual([
      {
        groupId: "booking.hotel_profile",
        owningStepId: "present_hotel",
        port: "catalog",
        entityOwnerDomain: "hotel_catalog",
      },
      {
        groupId: "booking.page_style",
        owningStepId: "booking_design",
        port: "booking",
        entityOwnerDomain: "booking",
      },
      {
        groupId: "booking.rooms",
        owningStepId: "rooms",
        port: "pms",
        entityOwnerDomain: "pms",
      },
      {
        groupId: "booking.pricing",
        owningStepId: "pricing",
        port: "pms",
        entityOwnerDomain: "pms",
      },
      {
        groupId: "booking.calendar",
        owningStepId: "calendar",
        port: "pms",
        entityOwnerDomain: "pms",
      },
      {
        groupId: "booking.guest_experience",
        owningStepId: "guest_experience",
        port: "booking",
        entityOwnerDomain: "booking",
      },
      {
        groupId: "booking.payments",
        owningStepId: "payments",
        port: "finance",
        entityOwnerDomain: "finance",
      },
    ]);
    expect(
      BOOKING_LAUNCH_READINESS_GROUPS.every(({ groupId }) => !groupId.includes("marketplace")),
    ).toBe(true);
  });

  it("keeps authoritative source ownership explicit at each port", () => {
    expect(BOOKING_LAUNCH_SOURCE_DOMAIN_BY_PORT).toEqual({
      catalog: "hotel_catalog",
      booking: "booking",
      pms: "pms",
      finance: "finance",
    });
  });

  it("uses the same method shape for every injected owner and VAY-1046 consumer", () => {
    expectTypeOf<BookingLaunchCatalogEvidencePort["getBookingLaunchEvidence"]>().toBeFunction();
    expectTypeOf<
      BookingLaunchConfigurationEvidencePort["getBookingLaunchEvidence"]
    >().toBeFunction();
    expectTypeOf<BookingLaunchPmsEvidencePort["getBookingLaunchEvidence"]>().toBeFunction();
    expectTypeOf<BookingLaunchFinanceEvidencePort["getBookingLaunchEvidence"]>().toBeFunction();
    expectTypeOf<BookingLaunchReadinessProviderPort["getBookingReadiness"]>().toBeFunction();
    expectTypeOf<BookingLaunchCatalogEvidencePort>().not.toEqualTypeOf<BookingLaunchPmsEvidencePort>();
    expectTypeOf<BookingLaunchSourceOwnerDomain>().toEqualTypeOf<
      "hotel_catalog" | "booking" | "pms" | "finance"
    >();
    expectTypeOf<
      BookingLaunchSourceBinding["expectedSource"]["ownerDomain"]
    >().toEqualTypeOf<BookingLaunchSourceOwnerDomain>();
    expectTypeOf<BookingLaunchOwnerEvidenceResult>().toMatchTypeOf<
      | {
          outcome: "evidence";
          port: "catalog" | "booking" | "pms" | "finance";
          organizationId: string;
          propertyId: string;
        }
      | {
          outcome: "unavailable";
          port: "catalog" | "booking" | "pms" | "finance";
          errorSource: "provider" | "system";
        }
    >();
  });
});
