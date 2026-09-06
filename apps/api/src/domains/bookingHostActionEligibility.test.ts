import { describe, expect, it } from "vitest";
import {
  hostBookingActionConflict,
  type HostBookingActionState,
} from "./bookingHostActionEligibility.js";

const booking: HostBookingActionState = {
  sourceSystem: "booking",
  lifecycleStatus: "confirmed",
  paymentStatus: "unpaid",
  paymentMethod: "pay_at_property",
  acceptanceMode: "instant",
  operationalStayStarted: false,
  hasPurchasedAddons: false,
};

describe("host Booking action eligibility", () => {
  it("allows date editing and cancellation of confirmed unpaid direct stays", () => {
    expect(hostBookingActionConflict("edit_dates", booking)).toBeNull();
    expect(hostBookingActionConflict("cancel", booking)).toBeNull();
  });
  it("rejects only pending host requests, including manual bank-transfer approval", () => {
    const pending = { ...booking, lifecycleStatus: "pending_payment" };
    expect(hostBookingActionConflict("reject", pending)?.code).toBe("invalid_lifecycle");
    expect(
      hostBookingActionConflict("reject", { ...pending, acceptanceMode: "request" }),
    ).toBeNull();
    expect(
      hostBookingActionConflict("reject", { ...pending, paymentMethod: "bank_transfer" }),
    ).toBeNull();
    expect(hostBookingActionConflict("reject", booking)?.code).toBe("invalid_lifecycle");
  });
  it.each(["draft", "pending_payment", "declined", "canceled", "completed", "expired"])(
    "cannot cancel or edit a %s booking",
    (lifecycleStatus) => {
      for (const action of ["edit_dates", "cancel"] as const)
        expect(hostBookingActionConflict(action, { ...booking, lifecycleStatus })?.code).toBe(
          "invalid_lifecycle",
        );
    },
  );
  it.each(["authorized", "pending", "paid", "partially_refunded", "refunded"])(
    "requires Finance handling for %s money",
    (paymentStatus) => {
      expect(hostBookingActionConflict("cancel", { ...booking, paymentStatus })?.code).toBe(
        "payment_adjustment_required",
      );
      expect(
        hostBookingActionConflict("reject", {
          ...booking,
          paymentStatus,
          lifecycleStatus: "pending_payment",
          acceptanceMode: "request",
        })?.code,
      ).toBe("payment_adjustment_required");
    },
  );
  it("permits Finance to void an authorized card request before rejection", () => {
    expect(
      hostBookingActionConflict("reject", {
        ...booking,
        lifecycleStatus: "pending_payment",
        acceptanceMode: "request",
        paymentMethod: "card",
        paymentStatus: "authorized",
      }),
    ).toBeNull();
  });
  it("preserves the manual and external channel owner boundaries", () => {
    expect(hostBookingActionConflict("cancel", { ...booking, sourceSystem: "pms" })?.code).toBe(
      "manual_action_required",
    );
    for (const sourceSystem of ["channex", "legacy", "unknown"])
      expect(hostBookingActionConflict("cancel", { ...booking, sourceSystem })?.code).toBe(
        "channel_action_unavailable",
      );
  });
  it("does not permit booked dates to override a started operational stay", () => {
    expect(
      hostBookingActionConflict("cancel", { ...booking, operationalStayStarted: true })?.code,
    ).toBe("operational_stay_started");
  });
  it("keeps add-on and bank-transfer repricing unavailable without blocking cancellation", () => {
    for (const changed of [{ hasPurchasedAddons: true }, { paymentMethod: "bank_transfer" }]) {
      expect(hostBookingActionConflict("edit_dates", { ...booking, ...changed })?.code).toBe(
        "unsupported_edit",
      );
      expect(hostBookingActionConflict("cancel", { ...booking, ...changed })).toBeNull();
    }
  });
});
