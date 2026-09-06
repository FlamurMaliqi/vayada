import {
  preparePmsHostDateAmendment,
  completePmsHostDateAmendment,
} from "./pmsHostDateAmendment.js";
import {
  createFinanceHostBookingPayments,
  type FinanceHostBookingPayments,
} from "./financeHostBookingPayments.js";
import { cancelHostBookingAssignments } from "./pmsHostBookingCancellation.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import type { PoolClient } from "pg";

/** Owner ports run in the caller's transaction, after its Booking row lock. */
export type BookingHostActionGuards = {
  prepareDateEdit: typeof preparePmsHostDateAmendment;
  completeDateEdit: typeof completePmsHostDateAmendment;
  cancelAssignments: typeof cancelHostBookingAssignments;
  lockInventory(client: PoolClient, propertyId: string): Promise<void>;
  stayStarted(client: PoolClient, propertyId: string, bookingId: string): Promise<boolean>;
  payment: FinanceHostBookingPayments;
};

export const targetBookingHostActionGuards: BookingHostActionGuards = {
  prepareDateEdit: preparePmsHostDateAmendment,
  completeDateEdit: completePmsHostDateAmendment,
  cancelAssignments: cancelHostBookingAssignments,
  lockInventory: lockPmsInventoryMutationScope,
  async stayStarted(client, propertyId, bookingId) {
    const result = await client.query<{ status: string }>(
      `SELECT assignment_status AS status FROM pms.operational_booking_assignments
       WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid FOR UPDATE`,
      [propertyId, bookingId],
    );
    return result.rows.some(({ status }) =>
      ["checked_in", "in_house", "checked_out"].includes(status),
    );
  },
  payment: createFinanceHostBookingPayments(),
};
