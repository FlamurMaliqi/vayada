export type HostBookingAction = "edit_dates" | "reject" | "cancel";
export type HostBookingConflictCode =
  | "channel_action_unavailable"
  | "manual_action_required"
  | "invalid_lifecycle"
  | "operational_stay_started"
  | "payment_adjustment_required"
  | "unsupported_edit"
  | "stale_preview"
  | "inventory_unavailable";

export type HostBookingConflict = { code: HostBookingConflictCode; message: string };
export type HostBookingActionState = {
  sourceSystem: string;
  lifecycleStatus: string;
  paymentStatus: string;
  paymentMethod: string | null;
  acceptanceMode: string | null;
  operationalStayStarted: boolean;
  hasPurchasedAddons: boolean;
};

/** Eligibility is deliberately independent of the PMS route or a guest email. */
export function hostBookingActionConflict(
  action: HostBookingAction,
  booking: HostBookingActionState,
): HostBookingConflict | null {
  if (booking.sourceSystem === "pms")
    return { code: "manual_action_required", message: "Use the manual booking action." };
  if (booking.sourceSystem !== "booking")
    return {
      code: "channel_action_unavailable",
      message: "This booking must be changed through its channel provider.",
    };
  if (booking.operationalStayStarted)
    return { code: "operational_stay_started", message: "This stay has already started." };
  if (
    action === "reject"
      ? booking.lifecycleStatus !== "pending_payment" ||
        (booking.acceptanceMode !== "request" && booking.paymentMethod !== "bank_transfer")
      : booking.lifecycleStatus !== "confirmed"
  )
    return { code: "invalid_lifecycle", message: "The booking is not eligible for this action." };
  const voidableRequest =
    action === "reject" &&
    booking.paymentStatus === "authorized" &&
    booking.paymentMethod === "card";
  if (
    !voidableRequest &&
    (booking.paymentStatus !== "unpaid" ||
      !["pay_at_property", "cash", "bank_transfer"].includes(booking.paymentMethod ?? ""))
  )
    return {
      code: "payment_adjustment_required",
      message: "This booking requires a payment adjustment before it can be changed.",
    };
  if (
    action === "edit_dates" &&
    (booking.hasPurchasedAddons ||
      !["pay_at_property", "cash"].includes(booking.paymentMethod ?? ""))
  )
    return {
      code: "unsupported_edit",
      message: "Date editing requires an unpaid pay-at-property booking without purchased add-ons.",
    };
  return null;
}
