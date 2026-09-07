import type { InventoryReservationTransaction } from "../platform/inventoryReservation.js";

/** PMS owns whether otherwise distinct room types sell the same physical space. */
export async function readPmsRoomSelectionConflicts(
  transaction: InventoryReservationTransaction,
  propertyId: string,
  roomTypeIds: readonly string[],
): Promise<Map<string, string | null>> {
  const result = await transaction.query<{ roomTypeId: string; groupId: string | null }>(
    `SELECT id::text AS "roomTypeId",linked_inventory_group_id::text AS "groupId"
     FROM pms.room_types WHERE property_id=$1::uuid AND id=ANY($2::uuid[])`,
    [propertyId, roomTypeIds],
  );
  return new Map(result.rows.map((row) => [row.roomTypeId, row.groupId]));
}

export async function pmsRoomStayRestrictionsAllow(
  transaction: InventoryReservationTransaction,
  input: {
    propertyId: string;
    roomTypeId: string;
    ratePlanId: string | null;
    checkIn: string;
    checkOut: string;
  },
): Promise<boolean> {
  const result = await transaction.query<{ blocked: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM pms.rate_rules rule
      WHERE property_id=$1::uuid AND room_type_id=$2::uuid
        AND (rate_plan_id IS NULL OR rate_plan_id=$3::uuid)
        AND (($4::date BETWEEN starts_on AND ends_on AND EXTRACT(DOW FROM $4::date)::int=ANY(days_of_week)
          AND (closed_to_arrival OR min_stay_nights>($5::date-$4::date) OR max_stay_nights<($5::date-$4::date)))
          OR ($5::date BETWEEN starts_on AND ends_on AND EXTRACT(DOW FROM $5::date)::int=ANY(days_of_week)
            AND closed_to_departure))) AS blocked`,
    [input.propertyId, input.roomTypeId, input.ratePlanId, input.checkIn, input.checkOut],
  );
  return result.rows[0]?.blocked === false;
}
