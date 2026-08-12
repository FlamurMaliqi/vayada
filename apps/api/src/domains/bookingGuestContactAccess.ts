import type { PropertyPlanReadModel } from "@vayada/domain-finance";

import { activeBookingPlanEntitlementSql } from "./propertyPlanReadModel.js";

export const HIDDEN_GUEST_CONTACT = "Hidden until you accept";

export const BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL = `(
  EXISTS (
    SELECT 1
    FROM booking.booking_status_events contact_event
    WHERE contact_event.guest_booking_id = booking.id
      AND (
        contact_event.event_type IN (
          'guest_booking.accepted',
          'booking.accepted',
          'booking_accepted'
        )
        OR (
          contact_event.actor_type = 'property_user'
          AND contact_event.from_status IS DISTINCT FROM contact_event.to_status
          AND contact_event.to_status = 'confirmed'
        )
        OR (
          contact_event.actor_type = 'migration'
          AND contact_event.to_status IN ('confirmed', 'completed', 'no_show')
        )
      )
  )
  OR EXISTS (
    SELECT 1
    FROM pms.operational_booking_assignments contact_assignment
    WHERE contact_assignment.guest_booking_id = booking.id
      AND contact_assignment.assignment_status IN ('checked_in', 'in_house', 'checked_out')
  )
  OR EXISTS (
    SELECT 1
    FROM pms.booking_checkin_records contact_checkin
    WHERE contact_checkin.guest_booking_id = booking.id
  )
  OR EXISTS (
    SELECT 1
    FROM pms.booking_checkout_records contact_checkout
    WHERE contact_checkout.guest_booking_id = booking.id
  )
)`;

export const PROPERTY_ALWAYS_HAS_GUEST_CONTACT_SQL = `COALESCE((
    SELECT COUNT(*) = 1 AND BOOL_AND(plan_key = 'fixed')
    FROM finance.billing_entitlements
    WHERE property_id = booking.property_id
      AND ${activeBookingPlanEntitlementSql()}
  ), FALSE)`;

export function guestContactForPropertyPlan(
  propertyPlan: PropertyPlanReadModel,
  hasEverBeenAccepted: boolean,
  contact: { email: string | null; phone: string | null },
): { email: string | null; phone: string | null } {
  if (propertyCanAccessGuestContact(propertyPlan, hasEverBeenAccepted)) {
    return contact;
  }
  return { email: HIDDEN_GUEST_CONTACT, phone: HIDDEN_GUEST_CONTACT };
}

export function propertyCanAccessGuestContact(
  propertyPlan: PropertyPlanReadModel,
  hasEverBeenAccepted: boolean,
): boolean {
  return propertyPlan.limits.guestContactAccess === "always" || hasEverBeenAccepted;
}
