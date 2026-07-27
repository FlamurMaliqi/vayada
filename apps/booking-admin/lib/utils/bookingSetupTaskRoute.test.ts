import { describe, expect, it } from "vitest";

import {
  bookingSettingsSectionForSetupTask,
  resolveBookingSetupTaskDestination,
} from "./bookingSetupTaskRoute";

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
  ])("routes $taskId to its domain-owned surface", (input) => {
    const route = resolveBookingSetupTaskDestination({
      taskId: input.taskId,
      destinationRouteKey: input.destinationRouteKey,
      planRevision: "plan-7",
      returnUrl: "/setup?entryProduct=booking",
    });

    expect(route).not.toBeNull();
    const url = new URL(route!, "https://admin.booking.localhost");
    expect(url.pathname).toBe(input.pathname);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      taskId: input.taskId,
      destinationRouteKey: input.destinationRouteKey,
      planRevision: "plan-7",
      returnUrl: "/setup?entryProduct=booking",
    });
    expect(bookingSettingsSectionForSetupTask(input.taskId, input.destinationRouteKey)).toBe(
      input.section,
    );
  });

  it("rejects incomplete, unknown, and mismatched task requests", () => {
    expect(
      resolveBookingSetupTaskDestination({
        taskId: "payment",
        destinationRouteKey: "booking.guest_settings_policies",
      }),
    ).toBeNull();
    expect(
      resolveBookingSetupTaskDestination({
        taskId: "rooms_rates_availability",
        destinationRouteKey: "pms.rooms_rates_availability",
      }),
    ).toBeNull();
    expect(
      resolveBookingSetupTaskDestination({
        taskId: null,
        destinationRouteKey: "finance.payment",
      }),
    ).toBeNull();
  });
});
