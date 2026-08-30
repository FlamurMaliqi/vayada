import { targetBooking } from "./productionPmsAssignmentRecords.js";
import { addPmsBlocker, propertyForHotel, safePmsSourceId } from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { PmsAssignmentBuild, PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";
import {
  currency,
  iso,
  money,
  optionalIso,
  optionalText,
  requiredText,
  uuid,
} from "./productionBookingValues.js";
import { jsonArray, optionalActor, pmsRecord } from "./productionPmsValues.js";

export function buildPmsGuestOperationsRecords(
  context: PmsBuildContext,
  assignments: PmsAssignmentBuild,
): PmsTargetRecord[] {
  const records: PmsTargetRecord[] = [];
  const builders: Record<string, (source: IdentitySourceRow) => PmsTargetRecord[]> = {
    checkin_checklist_templates: (source) => checklist(context, source, "checkin"),
    checkout_inspection_templates: (source) => checklist(context, source, "checkout"),
    booking_checkin_records: (source) => checkin(context, assignments, source),
    booking_checkout_charges: (source) => checkoutCharge(context, assignments, source),
    booking_checkout_records: (source) => checkout(context, assignments, source),
    booking_notes: (source) => privateNote(context, source),
  };
  for (const [table, build] of Object.entries(builders))
    for (const source of context.rowsByTable.get(table) ?? [])
      try {
        records.push(...build(source));
      } catch (error) {
        addPmsBlocker(
          context,
          "INVALID_SOURCE_ROW",
          `pms.${table}`,
          safePmsSourceId(source, table.includes("templates") ? "hotel_id" : "id"),
          error instanceof Error ? error.message : "Invalid PMS guest operation",
        );
      }
  return records;
}

function checklist(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  kind: "checkin" | "checkout",
): PmsTargetRecord[] {
  const propertyId = propertyForHotel(context, source.data["hotel_id"]);
  const updatedAt = iso(source.data["updated_at"], "updated_at");
  const table =
    kind === "checkin" ? "checkin_checklist_templates" : "checkout_inspection_templates";
  return [
    pmsRecord(source, table, propertyId, updatedAt, true, {
      propertyId,
      steps: jsonArray(source.data["steps"], "steps"),
      updatedByUserId: optionalActor(source.data["updated_by"], "updated_by", context.userIds),
      updatedAt,
    }),
  ];
}

function checkin(
  context: PmsBuildContext,
  assignments: PmsAssignmentBuild,
  source: IdentitySourceRow,
): PmsTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const bookingId = uuid(source.data["booking_id"], "booking_id");
  const booking = targetBooking(context, bookingId);
  const completedAt = iso(source.data["completed_at"], "completed_at");
  return [
    pmsRecord(source, "booking_checkin_records", id, completedAt, false, {
      id,
      propertyId: booking.propertyId,
      guestBookingId: bookingId,
      assignmentId: firstAssignment(assignments, bookingId),
      completedByUserId: optionalActor(
        source.data["completed_by"],
        "completed_by",
        context.userIds,
      ),
      completedAt,
      stepResults: jsonArray(source.data["step_results"], "step_results"),
      pendingFlags: jsonArray(source.data["pending_flags"], "pending_flags"),
    }),
  ];
}

function checkoutCharge(
  context: PmsBuildContext,
  assignments: PmsAssignmentBuild,
  source: IdentitySourceRow,
): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const bookingId = uuid(data["booking_id"], "booking_id");
  const booking = targetBooking(context, bookingId);
  if (propertyForHotel(context, data["hotel_id"]) !== booking.propertyId)
    throw new Error("checkout charge crosses booking property scope");
  const status = requiredText(data["status"], "status").toLowerCase();
  if (!["pending", "paid", "waived"].includes(status))
    throw new Error(`checkout charge status ${status} is unsupported`);
  const createdAt = iso(data["created_at"], "created_at");
  const settledAt = optionalIso(data["settled_at"], "settled_at");
  const waivedAt = optionalIso(data["waived_at"], "waived_at");
  const sourceUpdatedAt = waivedAt ?? settledAt ?? createdAt;
  return [
    pmsRecord(source, "booking_checkout_charges", id, sourceUpdatedAt, true, {
      id,
      propertyId: booking.propertyId,
      guestBookingId: bookingId,
      assignmentId: firstAssignment(assignments, bookingId),
      label: requiredText(data["label"], "label"),
      amount: money(data["amount"], "amount"),
      originalAmount: money(data["original_amount"], "original_amount"),
      currency: currency(booking.target.currency),
      status,
      createdByUserId: optionalActor(data["created_by"], "created_by", context.userIds),
      createdAt,
      settledAt,
      waivedAt,
    }),
  ];
}

function checkout(
  context: PmsBuildContext,
  assignments: PmsAssignmentBuild,
  source: IdentitySourceRow,
): PmsTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const bookingId = uuid(source.data["booking_id"], "booking_id");
  const booking = targetBooking(context, bookingId);
  const completedAt = iso(source.data["completed_at"], "completed_at");
  return [
    pmsRecord(source, "booking_checkout_records", id, completedAt, false, {
      id,
      propertyId: booking.propertyId,
      guestBookingId: bookingId,
      assignmentId: firstAssignment(assignments, bookingId),
      completedByUserId: optionalActor(
        source.data["completed_by"],
        "completed_by",
        context.userIds,
      ),
      completedAt,
      inspectionResults: jsonArray(source.data["inspection_results"], "inspection_results"),
      chargesSettled: jsonArray(source.data["charges_settled"], "charges_settled"),
      pendingFlags: jsonArray(source.data["pending_flags"], "pending_flags"),
      checkoutNotes: optionalText(source.data["checkout_notes"], "checkout_notes"),
    }),
  ];
}

function privateNote(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const bookingId = uuid(data["booking_id"], "booking_id");
  const booking = targetBooking(context, bookingId);
  if (propertyForHotel(context, data["hotel_id"]) !== booking.propertyId)
    throw new Error("private note crosses booking property scope");
  const createdAt = iso(data["created_at"], "created_at");
  return [
    pmsRecord(source, "booking_notes_private", id, createdAt, true, {
      id,
      propertyId: booking.propertyId,
      guestBookingId: bookingId,
      authorUserId: optionalActor(data["author_user_id"], "author_user_id", context.userIds),
      authorDisplayName: optionalText(data["author_name"], "author_name") ?? "",
      body: requiredText(data["body"], "body"),
      source: "pms",
      createdAt,
      editedByUserId: null,
      editedByDisplayName: null,
      editedAt: null,
    }),
  ];
}

function firstAssignment(assignments: PmsAssignmentBuild, bookingId: string): string {
  const id = assignments.assignmentByBookingPosition.get(`${bookingId}:1`);
  if (!id) throw new Error(`booking ${bookingId} has no operational assignment`);
  return id;
}
