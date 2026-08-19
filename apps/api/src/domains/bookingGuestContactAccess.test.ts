import { describe, expect, it } from "vitest";

import {
  BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL,
  guestContactForPropertyPlan,
  HIDDEN_GUEST_CONTACT,
  PROPERTY_ALWAYS_HAS_GUEST_CONTACT_SQL,
  propertyCanAccessGuestContact,
} from "./bookingGuestContactAccess.js";

const commissionPlan = {
  propertyId: "property-1",
  plan: "commission" as const,
  limits: {
    maxRoomPhotosPerType: 10,
    maxAddons: 3,
    guestContactAccess: "after_acceptance" as const,
  },
};

const fixedPlan = {
  ...commissionPlan,
  plan: "fixed" as const,
  limits: { ...commissionPlan.limits, guestContactAccess: "always" as const },
};

describe("guestContactForPropertyPlan", () => {
  it("hides commission guest contact until host acceptance", () => {
    expect(
      guestContactForPropertyPlan(commissionPlan, false, {
        email: "guest@example.com",
        phone: "+4912345",
      }),
    ).toEqual({ email: HIDDEN_GUEST_CONTACT, phone: HIDDEN_GUEST_CONTACT });
  });

  it("keeps commission guest contact visible after acceptance", () => {
    expect(
      guestContactForPropertyPlan(commissionPlan, true, {
        email: "guest@example.com",
        phone: "+4912345",
      }),
    ).toEqual({ email: "guest@example.com", phone: "+4912345" });
  });

  it("always returns fixed-plan guest contact", () => {
    expect(
      guestContactForPropertyPlan(fixedPlan, false, {
        email: "guest@example.com",
        phone: null,
      }),
    ).toEqual({ email: "guest@example.com", phone: null });
  });

  it("does not treat payment confirmation as host acceptance", () => {
    expect(BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL).not.toContain("actor_type = 'property_user'");
    expect(BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL).toContain("'guest_booking.created'");
    expect(BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL).toContain("'guest_booking.payment_received'");
    expect(BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL).toContain(
      "booking.booking_metadata ->> 'acceptanceMode' = 'instant'",
    );
    expect(BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL).toContain("to_status = 'confirmed'");
    expect(BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL).not.toContain("payment_status");
  });

  it("fails closed when more than one active booking plan entitlement exists", () => {
    expect(PROPERTY_ALWAYS_HAS_GUEST_CONTACT_SQL).toContain("COUNT(*) = 1");
    expect(PROPERTY_ALWAYS_HAS_GUEST_CONTACT_SQL).toContain("BOOL_AND(plan_key = 'fixed')");
  });

  it("does not grant commission properties write access before acceptance", () => {
    expect(propertyCanAccessGuestContact(commissionPlan, false)).toBe(false);
    expect(propertyCanAccessGuestContact(commissionPlan, true)).toBe(true);
    expect(propertyCanAccessGuestContact(fixedPlan, false)).toBe(true);
  });
});
