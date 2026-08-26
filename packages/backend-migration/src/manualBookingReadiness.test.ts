import { describe, expect, it } from "vitest";
// prettier-ignore
import { MANUAL_BOOKING_ADDON_MODELS, MANUAL_BOOKING_PAYMENT_METHODS, MANUAL_BOOKING_READINESS_SQL, runManualBookingReadiness } from "./manualBookingReadiness.js";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const propertyId = uuid(900),
  digest = "a".repeat(64);
// prettier-ignore
const baseExpected = { currency: "EUR", directSource: "email", expectedPaymentMethod: "cash", paymentStatus: "unpaid" as const, totalAmount: "410.00", balanceAmount: "410.00", stays: [{ position: 1, roomId: uuid(21), roomTypeId: uuid(31), checkIn: "2027-01-01", checkOut: "2027-01-03", adults: 2, children: 0, ratePlanId: null }, { position: 2, roomId: uuid(22), roomTypeId: uuid(32), checkIn: "2027-01-02", checkOut: "2027-01-04", adults: 1, children: 1, ratePlanId: uuid(99) }], nightly: [{ position: 1, serviceDate: "2027-01-01", amount: "100" }, { position: 1, serviceDate: "2027-01-02", amount: "100" }, { position: 2, serviceDate: "2027-01-02", amount: "90" }, { position: 2, serviceDate: "2027-01-03", amount: "110" }], addOns: MANUAL_BOOKING_ADDON_MODELS.map((pricingModel, index) => ({ addonId: uuid(50 + index), pricingModel, unitPrice: { amountDecimal: "2.50", currency: "EUR" }, packageCount: 1, serviceUnits: [{ serviceDate: pricingModel.includes("night") ? "2027-01-02" : null, guestCount: pricingModel.includes("guest") ? 1 : null }], totalAmount: "2.50", currency: "EUR" })), seasons: [{ sourceId: uuid(80), position: 2, roomTypeId: uuid(32), ratePlanId: uuid(99), startMonthDay: "01-03", endMonthDay: "02-28" }] };
// prettier-ignore
const lifecycle = (scenario: string, index: number) => ({ guestBookingId: uuid(100 + index), propertyId, scenarios: [scenario], expected: { ...baseExpected, ...(scenario.endsWith("_refund") ? { paymentStatus: "paid" as const, balanceAmount: "0", totalAmount: "400", addOns: [] } : {}), lifecycle: { kind: scenario.endsWith("_refund") ? "refund" : scenario, lifecycleStatus: scenario === "cancellation" ? "canceled" : "confirmed", paymentStatus: scenario === "full_refund" ? "refunded" as const : scenario === "partial_refund" ? "paid" as const : "unpaid" as const, totalAmount: scenario.endsWith("_refund") ? "400" : "410", balanceAmount: scenario.endsWith("_refund") ? "0" : "410", assignmentStatuses: [scenario === "cancellation" ? "canceled" : scenario === "no_show" ? "released" : "assigned"], roomIds: [scenario === "cancellation" || scenario === "no_show" ? null : uuid(21)], occupiedRoomNights: scenario === "cancellation" || scenario === "no_show" ? 0 : 4, revenueTotal: scenario === "partial_refund" ? "200" : scenario === "full_refund" ? "0" : scenario === "price_correction" ? "420" : scenario === "cancellation" || scenario === "no_show" ? "0" : "400", refundTotal: scenario === "partial_refund" ? "200" : scenario === "full_refund" ? "400" : "0", eventCounts: { room_night: 4, [scenario.endsWith("_refund") ? "refund" : scenario === "price_correction" ? "correction" : "occupancy_adjustment"]: 1 }, operationCounts: { "pms.manual_booking.create": 1, [scenario === "no_show" ? "no_show_command" : `manual_${scenario.endsWith("_refund") ? "refund" : scenario}_command`]: 1 }, auditCounts: { "pms.manual_booking.create": 1, [scenario === "no_show" ? "pms.no_show" : `pms.manual_${scenario.endsWith("_refund") ? "refund" : scenario}`]: 1, ...(scenario.endsWith("_refund") ? { "finance.manual_booking_refund": 1 } : {}) }, outboxCounts: { "booking.guest_confirmation.requested.v1": 1 } } } });
// prettier-ignore
const cases = [...MANUAL_BOOKING_PAYMENT_METHODS.flatMap((expectedPaymentMethod, methodIndex) => (["paid", "unpaid"] as const).map((paymentStatus, statusIndex) => ({ guestBookingId: uuid(methodIndex * 2 + statusIndex + 1), propertyId, scenarios: methodIndex === 0 && statusIndex === 0 ? ["custom_rate", "cross_season", "heterogeneous_dates", "email_source"] : [], expected: { ...baseExpected, expectedPaymentMethod, paymentStatus, balanceAmount: paymentStatus === "paid" ? "0" : "410" } }))), ...["cancellation", "no_show", "partial_refund", "full_refund", "stay_correction", "price_correction"].map(lifecycle)];
// prettier-ignore
const manifest = { contractVersion: "pms-manual-booking-rehearsal.v1", runId: "run-1", propertyIds: [propertyId], snapshot: { id: "snapshot-1", capturedAt: "2026-08-13T10:00:00Z" }, restoreRehearsal: { id: "restore-1", completedAt: "2026-08-13T10:30:00Z", status: "passed" }, cutover: { watermark: "2026-08-13T09:00:00Z", reviewedBy: "release-owner", reviewedAt: "2026-08-13T11:00:00Z" }, cases };
// prettier-ignore
const row = (item: (typeof cases)[number]) => {
  const current = "lifecycle" in item.expected ? item.expected.lifecycle : undefined;
  return { guestBookingId: item.guestBookingId, propertyId, lifecycleStatus: current?.lifecycleStatus ?? "confirmed", roomCount: 2, assignmentCount: 2, exactAssignmentCount: 2, expectedNightCount: 4, headerValid: true, nightlyCount: 4, invalidNightCount: 0, nightlyTotal: "400.0000", addonTotal: "10", totalAmount: current?.totalAmount ?? "410", balanceAmount: current?.balanceAmount ?? item.expected.balanceAmount, currency: "EUR", paymentStatus: current?.paymentStatus ?? item.expected.paymentStatus, expectedPaymentMethod: item.expected.expectedPaymentMethod, bookingChannel: "direct", directSource: "email", attributionValid: true, paymentCount: item.expected.paymentStatus === "paid" ? 1 : 0, paymentTotal: item.expected.paymentStatus === "paid" ? "410" : "0", paymentMatchCount: item.expected.paymentStatus === "paid" ? 1 : 0, refundTotal: current?.refundTotal ?? "0", bookerCount: 1, privateNoteLeakCount: 0, guestConfirmationMatches: true, platformChainValid: true, occupiedRoomNights: current?.occupiedRoomNights ?? 4, revenueTotal: current?.revenueTotal ?? "400", assignmentStatuses: current?.assignmentStatuses ?? ["assigned", "assigned"], roomIds: current?.roomIds ?? [uuid(21), uuid(22)], eventCounts: current?.eventCounts ?? { room_night: 4 }, operationCounts: current?.operationCounts ?? { "pms.manual_booking.create": 1 }, auditCounts: current?.auditCounts ?? { "pms.manual_booking.create": 1 }, outboxCounts: current?.outboxCounts ?? { "booking.guest_confirmation.requested.v1": 1 }, stays: item.expected.stays, nightly: item.expected.nightly.map((night) => ({ ...night, amount: `${night.amount}.0000` })), addOns: item.expected.addOns.map((addon) => ({ ...addon, unitPrice: { ...addon.unitPrice, amountDecimal: "2.5000" }, totalAmount: "2.5000" })), seasons: item.expected.seasons };
};
// prettier-ignore
const client = (rows: unknown[], cohort = cases.map(({ guestBookingId }) => ({ id: guestBookingId }))) => ({ query: async (sql: string) => ({ rows: sql.startsWith("SHOW") ? [{ transaction_read_only: "on" }] : sql.includes("created_at <=") ? cohort : rows }) });

describe("target manual-booking release readiness", () => {
  // prettier-ignore
  it("passes a reviewed, complete creation and lifecycle cohort", async () => {
    const report = await runManualBookingReadiness(client(cases.map(row)) as never, { manifest, manifestSha256: digest, reviewedSha256: digest, now: new Date("2026-08-13T12:00:00Z") });
    expect(report).toMatchObject({ status: "ready", summary: { bookings: 16, paid: 6, unpaid: 9, refunded: 1, blockers: 0 }, findings: [] });
    expect(MANUAL_BOOKING_READINESS_SQL).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });

  // prettier-ignore
  it("fails an unreviewed digest before target queries", async () => {
    let targetQueried = false; const report = await runManualBookingReadiness({ query: async (sql: string) => { if (!sql.startsWith("SHOW")) targetQueried = true; return { rows: [{ transaction_read_only: "on" }] }; } } as never, { manifest, manifestSha256: digest, reviewedSha256: "b".repeat(64) });
    expect(targetQueried).toBe(false); expect(report.findings[0]?.code).toBe("EVIDENCE_MANIFEST_INVALID");
  });

  // prettier-ignore
  it("blocks omitted cohort members, changed lifecycle facts, and lifecycle injection", async () => {
    const rows = cases.map(row); rows.at(-1)!.revenueTotal = "999"; const cohort = [...cases.map(({ guestBookingId }) => ({ id: guestBookingId })), { id: uuid(999) }], changed = structuredClone(manifest), finalExpected = cases.at(-1)!.expected; (changed.cases[0]!.expected as Record<string, unknown>)["lifecycle"] = structuredClone((finalExpected as { lifecycle: object }).lifecycle);
    const report = await runManualBookingReadiness(client(rows, cohort) as never, { manifest: changed, manifestSha256: digest, reviewedSha256: digest });
    expect(new Set(report.findings.map(({ code }) => code))).toEqual(new Set(["TARGET_COHORT_MISMATCH", "LIFECYCLE_EVIDENCE_MISMATCH", "REHEARSAL_EXPECTATION_MISMATCH", "SCENARIO_INVALID"]));
  });

  // prettier-ignore
  it("requires read-only execution", async () => {
    await expect(runManualBookingReadiness({ query: async () => ({ rows: [{ transaction_read_only: "off" }] }) } as never, { manifest, manifestSha256: digest, reviewedSha256: digest })).rejects.toThrow("read-only");
  });
});
