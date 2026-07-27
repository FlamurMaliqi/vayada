import { describe, expect, it } from "vitest";

import {
  bookingSettingsSectionForSetupTask,
  hasBookingSetupTaskContext,
  parseBookingSetupTaskContext,
  resolveBookingSetupTaskDestination,
} from "./bookingSetupTaskRoute";

const PROPERTY_ID = "f6853000-0000-4000-8000-000000000001";
const MARKETPLACE_ORIGIN = "https://marketplace.localhost";
const RETURN_URL = `${MARKETPLACE_ORIGIN}/setup?propertyId=${PROPERTY_ID}`;
const storage = {
  getItem: (key: string) => (key === "selectedSharedPropertyId" ? PROPERTY_ID : null),
};

describe("resolveBookingSetupTaskDestination", () => {
  it.each([
    {
      taskId: "guest_settings_policies",
      destinationRouteKey: "booking.guest_settings_policies",
      pathname: "/settings",
      section: "booking",
    },
    {
      taskId: "payment",
      destinationRouteKey: "finance.payment",
      pathname: "/settings",
      section: "payments",
    },
    {
      taskId: "direct_booking_publication",
      destinationRouteKey: "distribution.direct_booking_publication",
      pathname: "/design-studio",
      section: null,
    },
  ] as const)("routes $taskId to its domain-owned surface", (input) => {
    const route = resolveBookingSetupTaskDestination({
      propertyId: PROPERTY_ID,
      taskId: input.taskId,
      destinationRouteKey: input.destinationRouteKey,
      planRevision: "plan-7",
      returnUrl: RETURN_URL,
      marketplaceOrigin: MARKETPLACE_ORIGIN,
    });

    expect(route).not.toBeNull();
    const url = new URL(route!, "https://admin.booking.localhost");
    expect(url.pathname).toBe(input.pathname);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ...(input.section ? { section: input.section } : {}),
      taskId: input.taskId,
      destinationRouteKey: input.destinationRouteKey,
      planRevision: "plan-7",
      returnUrl: RETURN_URL,
    });
    expect(bookingSettingsSectionForSetupTask(input.taskId, input.destinationRouteKey)).toBe(
      input.section,
    );
    expect(
      parseBookingSetupTaskContext(url.searchParams, storage, MARKETPLACE_ORIGIN, input.pathname),
    ).toEqual({
      taskId: input.taskId,
      returnUrl: RETURN_URL,
      settingsSection: input.section,
    });
  });

  it("rejects incomplete, unknown, and mismatched task requests", () => {
    expect(
      resolveBookingSetupTaskDestination({
        propertyId: PROPERTY_ID,
        taskId: "payment",
        destinationRouteKey: "booking.guest_settings_policies",
        planRevision: "plan-7",
        returnUrl: RETURN_URL,
        marketplaceOrigin: MARKETPLACE_ORIGIN,
      }),
    ).toBeNull();
    expect(
      resolveBookingSetupTaskDestination({
        propertyId: PROPERTY_ID,
        taskId: "rooms_rates_availability",
        destinationRouteKey: "pms.rooms_rates_availability",
        planRevision: "plan-7",
        returnUrl: RETURN_URL,
        marketplaceOrigin: MARKETPLACE_ORIGIN,
      }),
    ).toBeNull();
    expect(
      resolveBookingSetupTaskDestination({
        propertyId: PROPERTY_ID,
        taskId: null,
        destinationRouteKey: "finance.payment",
        planRevision: "plan-7",
        returnUrl: RETURN_URL,
        marketplaceOrigin: MARKETPLACE_ORIGIN,
      }),
    ).toBeNull();
  });

  it.each([
    "https://evil.example/setup?propertyId=f6853000-0000-4000-8000-000000000001",
    "https://marketplace.localhost/marketplace?propertyId=f6853000-0000-4000-8000-000000000001",
    "https://marketplace.localhost/setup?propertyId=another-property",
    "https://marketplace.localhost/setup?propertyId=f6853000-0000-4000-8000-000000000001&next=https%3A%2F%2Fevil.example",
  ])("never forwards a non-canonical return URL: %s", (returnUrl) => {
    expect(
      resolveBookingSetupTaskDestination({
        propertyId: PROPERTY_ID,
        taskId: "payment",
        destinationRouteKey: "finance.payment",
        planRevision: "plan-7",
        returnUrl,
        marketplaceOrigin: MARKETPLACE_ORIGIN,
      }),
    ).toBeNull();
  });
});

describe("parseBookingSetupTaskContext", () => {
  function validSettingsParams(): URLSearchParams {
    return new URLSearchParams({
      section: "payments",
      taskId: "payment",
      destinationRouteKey: "finance.payment",
      planRevision: "plan-7",
      returnUrl: RETURN_URL,
    });
  }

  it("rejects duplicate, extra, mismatched, and property-unbound context", () => {
    const duplicate = validSettingsParams();
    duplicate.append("returnUrl", "https://evil.example/setup");
    expect(
      parseBookingSetupTaskContext(duplicate, storage, MARKETPLACE_ORIGIN, "/settings"),
    ).toBeNull();

    const extra = validSettingsParams();
    extra.set("propertyId", PROPERTY_ID);
    expect(
      parseBookingSetupTaskContext(extra, storage, MARKETPLACE_ORIGIN, "/settings"),
    ).toBeNull();

    const wrongSection = validSettingsParams();
    wrongSection.set("section", "booking");
    expect(
      parseBookingSetupTaskContext(wrongSection, storage, MARKETPLACE_ORIGIN, "/settings"),
    ).toBeNull();

    expect(
      parseBookingSetupTaskContext(
        validSettingsParams(),
        storage,
        MARKETPLACE_ORIGIN,
        "/design-studio",
      ),
    ).toBeNull();
    expect(
      parseBookingSetupTaskContext(
        validSettingsParams(),
        { getItem: () => "another-property" },
        MARKETPLACE_ORIGIN,
        "/settings",
      ),
    ).toBeNull();
    expect(
      parseBookingSetupTaskContext(validSettingsParams(), null, MARKETPLACE_ORIGIN, "/settings"),
    ).toBeNull();

    const paddedPlanRevision = validSettingsParams();
    paddedPlanRevision.set("planRevision", " plan-7 ");
    expect(
      parseBookingSetupTaskContext(paddedPlanRevision, storage, MARKETPLACE_ORIGIN, "/settings"),
    ).toBeNull();
  });

  it("distinguishes a setup-task request from unrelated page queries", () => {
    expect(hasBookingSetupTaskContext(validSettingsParams())).toBe(true);
    expect(hasBookingSetupTaskContext(new URLSearchParams({ section: "booking" }))).toBe(false);
  });
});
