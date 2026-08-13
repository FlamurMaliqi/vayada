import type pg from "pg";

// prettier-ignore
export const MANUAL_BOOKING_PAYMENT_METHODS = ["pay_at_property", "bank_transfer", "manual_card", "cash", "other"] as const;
// prettier-ignore
export const MANUAL_BOOKING_ADDON_MODELS = ["per_stay", "per_night", "per_guest", "per_guest_night"] as const;
// prettier-ignore
const DIRECT_SOURCES = new Set(["call", "email", "whatsapp", "walk_in", "social_media", "other"]);
// prettier-ignore
const REQUIRED_SCENARIOS = ["custom_rate", "cross_season", "heterogeneous_dates", "email_source", "cancellation", "no_show", "partial_refund", "full_refund", "stay_correction", "price_correction"] as const;
const LIFECYCLE_SCENARIOS = new Set(REQUIRED_SCENARIOS.slice(4));

type QueryExecutor = Pick<pg.ClientBase, "query">;
type PaymentStatus = "paid" | "unpaid" | "refunded";
// prettier-ignore
type ExpectedStay = { position: number; roomId: string; roomTypeId: string; checkIn: string; checkOut: string; adults: number; children: number; ratePlanId: string | null };
type ExpectedNight = { position: number; serviceDate: string; amount: string };
// prettier-ignore
type ExpectedAddon = { addonId: string; pricingModel: string; unitPrice: { amountDecimal: string; currency: string }; packageCount: number; serviceUnits: { serviceDate: string | null; guestCount: number | null }[]; totalAmount: string; currency: string };
// prettier-ignore
type ExpectedSeason = { sourceId: string; position: number; roomTypeId: string; ratePlanId: string; startMonthDay: string; endMonthDay: string };
// prettier-ignore
type ExpectedLifecycle = { kind: string; lifecycleStatus: string; paymentStatus: PaymentStatus; totalAmount: string; balanceAmount: string; assignmentStatuses: string[]; roomIds: (string | null)[]; occupiedRoomNights: number; revenueTotal: string; refundTotal: string; eventCounts: Record<string, number>; operationCounts: Record<string, number>; auditCounts: Record<string, number>; outboxCounts: Record<string, number> };
// prettier-ignore
type RehearsalCase = { guestBookingId: string; propertyId: string; scenarios: string[]; expected: { currency: string; directSource: string; expectedPaymentMethod: string; paymentStatus: "paid" | "unpaid"; totalAmount: string; balanceAmount: string; stays: ExpectedStay[]; nightly: ExpectedNight[]; addOns: ExpectedAddon[]; seasons: ExpectedSeason[]; lifecycle?: ExpectedLifecycle } };
// prettier-ignore
export type ManualBookingEvidenceManifest = { contractVersion: "pms-manual-booking-rehearsal.v1"; runId: string; propertyIds: string[]; snapshot: { id: string; capturedAt: string }; restoreRehearsal: { id: string; completedAt: string; status: "passed" }; cutover: { watermark: string; reviewedBy: string; reviewedAt: string }; cases: RehearsalCase[] };
// prettier-ignore
type ReadinessRow = { guestBookingId: string; propertyId: string; lifecycleStatus: string; roomCount: number; assignmentCount: number; exactAssignmentCount: number; expectedNightCount: number; headerValid: boolean; nightlyCount: number; invalidNightCount: number; nightlyTotal: string; addonTotal: string; totalAmount: string; balanceAmount: string; currency: string; paymentStatus: PaymentStatus; expectedPaymentMethod: string; bookingChannel: string | null; directSource: string | null; attributionValid: boolean; paymentCount: number; paymentTotal: string; paymentMatchCount: number; refundTotal: string; bookerCount: number; privateNoteLeakCount: number; guestConfirmationMatches: boolean; platformChainValid: boolean; occupiedRoomNights: number; revenueTotal: string; assignmentStatuses: string[]; roomIds: (string | null)[]; eventCounts: Record<string, number>; operationCounts: Record<string, number>; auditCounts: Record<string, number>; outboxCounts: Record<string, number>; stays: ExpectedStay[]; nightly: ExpectedNight[]; addOns: unknown; seasons: ExpectedSeason[] };
// prettier-ignore
export type ManualBookingReadinessFinding = { code: string; guestBookingId: string | null; message: string };
// prettier-ignore
export type ManualBookingReadinessReport = { contractVersion: "pms-manual-booking-readiness.v1"; scope: "target_typescript_v1_only"; generatedAt: string; status: "ready" | "blocked"; evidence: { runId: string | null; manifestSha256: string; snapshotId: string | null; restoreRehearsalId: string | null; cutoverWatermark: string | null; reviewedBy: string | null }; summary: { bookings: number; paid: number; unpaid: number; refunded: number; blockers: number }; findings: ManualBookingReadinessFinding[] };

export const MANUAL_BOOKING_READINESS_SQL = `
SELECT booking.id::text AS "guestBookingId", booking.property_id::text AS "propertyId",
  booking.lifecycle_status AS "lifecycleStatus", booking.room_count AS "roomCount",
  (SELECT count(*)::int FROM pms.operational_booking_assignments a WHERE a.guest_booking_id = booking.id) AS "assignmentCount",
  (SELECT count(*)::int FROM pms.operational_booking_assignments a WHERE a.guest_booking_id = booking.id AND a.stay_evidence_kind = 'exact') AS "exactAssignmentCount",
  (SELECT coalesce(sum(a.check_out - a.check_in), 0)::int FROM pms.operational_booking_assignments a WHERE a.guest_booking_id = booking.id AND a.stay_evidence_kind = 'exact') AS "expectedNightCount",
  (booking.lifecycle_status = 'confirmed' AND (SELECT min(a.check_in) = booking.check_in AND max(a.check_out) = booking.check_out AND sum(a.adults) = booking.adults AND sum(a.children) = booking.children FROM pms.operational_booking_assignments a WHERE a.guest_booking_id = booking.id AND a.stay_evidence_kind = 'exact')) AS "headerValid",
  (SELECT count(*)::int FROM booking.nightly_revenue_evidence n WHERE n.guest_booking_id = booking.id AND n.source_kind = 'manual' AND n.economic_event = 'room_night') AS "nightlyCount",
  (SELECT count(*)::int FROM booking.nightly_revenue_evidence n WHERE n.guest_booking_id = booking.id AND n.source_kind = 'manual' AND n.economic_event = 'room_night' AND (n.evidence_quality <> 'exact' OR NOT EXISTS (SELECT 1 FROM pms.operational_booking_assignments a WHERE a.guest_booking_id = booking.id AND a.position = n.line_position AND a.room_type_id = n.room_type_id AND n.stay_date >= a.check_in AND n.stay_date < a.check_out))) AS "invalidNightCount",
  (SELECT coalesce(sum(n.gross_room_amount), 0)::text FROM booking.nightly_revenue_evidence n WHERE n.guest_booking_id = booking.id AND n.source_kind = 'manual' AND n.economic_event = 'room_night') AS "nightlyTotal",
  (SELECT coalesce(sum(a.total_amount), 0)::text FROM booking.booking_addon_selections a WHERE a.guest_booking_id = booking.id) AS "addonTotal",
  booking.total_amount::text AS "totalAmount", booking.balance_amount::text AS "balanceAmount", booking.currency::text AS currency,
  booking.payment_status AS "paymentStatus", booking.expected_payment_method AS "expectedPaymentMethod", booking.booking_channel AS "bookingChannel", booking.direct_booking_source AS "directSource",
  (SELECT count(*) = 1 FROM booking.finance_booking_attribution attribution WHERE attribution.guest_booking_id = booking.id AND attribution.property_id = booking.property_id AND attribution.booking_channel = booking.booking_channel AND attribution.direct_booking_source = booking.direct_booking_source AND attribution.total_amount = booking.total_amount AND attribution.currency = booking.currency) AS "attributionValid",
  (SELECT count(*)::int FROM finance.payments p WHERE p.guest_booking_id = booking.id AND p.source_system = 'pms' AND p.payment_kind = 'manual' AND p.status = 'paid') AS "paymentCount",
  (SELECT coalesce(sum(p.amount), 0)::text FROM finance.payments p WHERE p.guest_booking_id = booking.id AND p.source_system = 'pms' AND p.payment_kind = 'manual' AND p.status = 'paid') AS "paymentTotal",
  (SELECT count(*)::int FROM finance.payments p JOIN platform.idempotency_keys i ON i.tenant_scope = 'property' AND i.property_id = booking.property_id AND i.operation_scope = 'pms' AND i.operation = 'pms.manual_booking.create' AND i.status = 'completed' AND i.response_resource_product = 'booking' AND i.response_resource_type = 'guest_booking' AND i.response_resource_id = booking.id::text AND i.idempotency_metadata->>'commandId' = booking.source_booking_id AND booking.booking_metadata->>'commandId' = i.idempotency_metadata->>'commandId' WHERE p.guest_booking_id = booking.id AND p.property_id = booking.property_id AND p.source_system = 'pms' AND p.source_payment_id = 'pms-manual-booking:' || booking.source_booking_id AND p.idempotency_key = 'finance.manual-booking-settlement:' || booking.property_id || ':' || i.key_hash || ':v1' AND p.payment_kind = 'manual' AND p.status = 'paid' AND p.currency = booking.currency AND p.payment_method = booking.expected_payment_method AND p.refunded_amount = 0 AND p.net_amount = p.amount AND p.visibility_class = 'pms_finance' AND p.payment_metadata->>'contractVersion' = 'finance-manual-booking-settlement.v1' AND p.payment_metadata->>'commandId' = booking.source_booking_id || ':settlement' AND p.payment_metadata->>'requestFingerprint' ~ '^[a-f0-9]{64}$') AS "paymentMatchCount",
  (SELECT coalesce(sum(p.amount), 0)::text FROM finance.payments p WHERE p.property_id=booking.property_id AND p.guest_booking_id=booking.id AND p.source_system='pms' AND p.payment_kind='refund' AND p.status='refunded') AS "refundTotal",
  (SELECT count(*)::int FROM booking.booking_guests g WHERE g.guest_booking_id = booking.id AND g.guest_role = 'booker') AS "bookerCount",
  (SELECT count(*)::int FROM pms.booking_notes_private note WHERE note.guest_booking_id = booking.id AND EXISTS (SELECT 1 FROM platform.outbox_events o WHERE o.resource_id = booking.id::text AND o.event_type = 'booking.guest_confirmation.requested.v1' AND position(to_jsonb(note.body)::text IN o.payload::text) > 0)) AS "privateNoteLeakCount",
  (SELECT count(*) = 1 AND bool_and(o.payload #>> '{guest,specialRequests}' IS NOT DISTINCT FROM (SELECT g.special_requests FROM booking.booking_guests g WHERE g.guest_booking_id = booking.id AND g.guest_role = 'booker' LIMIT 1)) FROM platform.outbox_events o WHERE o.resource_id = booking.id::text AND o.event_type = 'booking.guest_confirmation.requested.v1') AS "guestConfirmationMatches",
  ((SELECT count(*) = 1 FROM platform.idempotency_keys i WHERE i.operation_scope = 'pms' AND i.operation = 'pms.manual_booking.create' AND i.status = 'completed' AND i.property_id = booking.property_id AND i.response_resource_product = 'booking' AND i.response_resource_type = 'guest_booking' AND i.response_resource_id = booking.id::text)
    AND (SELECT count(*) = 1 FROM platform.domain_events e WHERE e.tenant_scope = 'property' AND e.property_id = booking.property_id AND e.resource_product = 'booking' AND e.resource_type = 'guest_booking' AND e.resource_id = booking.id::text AND e.event_type = 'pms.manual_booking.created.v1')
    AND (SELECT count(*) = 1 FROM platform.product_audit_events audit WHERE audit.tenant_scope = 'property' AND audit.property_id = booking.property_id AND audit.target_resource_product = 'booking' AND audit.target_resource_type = 'guest_booking' AND audit.target_resource_id = booking.id::text AND audit.action = 'pms.manual_booking.create')
    AND EXISTS (SELECT 1 FROM platform.idempotency_keys i JOIN platform.domain_events e ON e.tenant_scope = 'property' AND e.property_id = booking.property_id AND e.resource_product = 'booking' AND e.resource_type = 'guest_booking' AND e.resource_id = booking.id::text AND e.event_type = 'pms.manual_booking.created.v1' AND e.idempotency_key_hash = i.key_hash AND e.correlation_id = i.correlation_id JOIN platform.product_audit_events audit ON audit.tenant_scope = 'property' AND audit.domain_event_id = e.id AND audit.idempotency_key_id = i.id AND audit.property_id = booking.property_id AND audit.target_resource_product = 'booking' AND audit.target_resource_type = 'guest_booking' AND audit.target_resource_id = booking.id::text AND audit.action = 'pms.manual_booking.create' AND audit.correlation_id = e.correlation_id WHERE i.tenant_scope = 'property' AND i.operation_scope = 'pms' AND i.operation = 'pms.manual_booking.create' AND i.status = 'completed' AND i.property_id = booking.property_id AND i.response_resource_product = 'booking' AND i.response_resource_type = 'guest_booking' AND i.response_resource_id = booking.id::text AND i.idempotency_metadata->>'commandId' = booking.source_booking_id AND booking.booking_metadata->>'commandId' = i.idempotency_metadata->>'commandId' AND (SELECT count(*) = 4 AND count(DISTINCT o.event_type) = 4 AND bool_and((o.event_type, o.destination) IN (('pms.calendar.refresh.requested.v1','pms.calendar'),('pms.ari.changed.v1','pms.ari'),('booking.guest_confirmation.requested.v1','booking.guest-communication'),('pms.manual_booking.refresh.requested.v1','pms.read-model')) AND o.tenant_scope = 'property' AND o.resource_product = 'booking' AND o.resource_type = 'guest_booking' AND o.resource_id = booking.id::text AND o.payload->>'guestBookingId' = booking.id::text AND o.correlation_id = e.correlation_id AND o.idempotency_key_hash = i.key_hash) FROM platform.outbox_events o WHERE o.domain_event_id = e.id AND o.property_id = booking.property_id))) AS "platformChainValid",
  (SELECT coalesce(sum(n.occupied_room_nights),0)::int FROM booking.nightly_revenue_evidence n WHERE n.property_id=booking.property_id AND n.guest_booking_id=booking.id AND n.source_kind='manual') AS "occupiedRoomNights",
  (SELECT coalesce(sum(n.gross_room_amount),0)::text FROM booking.nightly_revenue_evidence n WHERE n.property_id=booking.property_id AND n.guest_booking_id=booking.id AND n.source_kind='manual') AS "revenueTotal",
  (SELECT coalesce(jsonb_agg(a.assignment_status ORDER BY a.position),'[]') FROM pms.operational_booking_assignments a WHERE a.property_id=booking.property_id AND a.guest_booking_id=booking.id) AS "assignmentStatuses",
  (SELECT coalesce(jsonb_agg(a.room_id::text ORDER BY a.position),'[]') FROM pms.operational_booking_assignments a WHERE a.property_id=booking.property_id AND a.guest_booking_id=booking.id) AS "roomIds",
  (SELECT coalesce(jsonb_object_agg(x.name,x.amount),'{}') FROM (SELECT n.economic_event name,count(*)::int amount FROM booking.nightly_revenue_evidence n WHERE n.property_id=booking.property_id AND n.guest_booking_id=booking.id AND n.source_kind='manual' GROUP BY n.economic_event) x) AS "eventCounts",
  (SELECT coalesce(jsonb_object_agg(x.name,x.amount),'{}') FROM (SELECT i.operation name,count(*)::int amount FROM platform.idempotency_keys i WHERE i.property_id=booking.property_id AND i.response_resource_id=booking.id::text AND i.status='completed' GROUP BY i.operation) x) AS "operationCounts",
  (SELECT coalesce(jsonb_object_agg(x.name,x.amount),'{}') FROM (SELECT audit.action name,count(*)::int amount FROM platform.product_audit_events audit WHERE audit.property_id=booking.property_id AND (audit.target_resource_id=booking.id::text OR (audit.action='finance.manual_booking_refund' AND EXISTS (SELECT 1 FROM finance.payments p WHERE p.id::text=audit.target_resource_id AND p.property_id=booking.property_id AND p.guest_booking_id=booking.id AND p.payment_kind='manual'))) GROUP BY audit.action) x) AS "auditCounts",
  (SELECT coalesce(jsonb_object_agg(x.name,x.amount),'{}') FROM (SELECT o.event_type name,count(*)::int amount FROM platform.outbox_events o WHERE o.property_id=booking.property_id AND o.resource_id=booking.id::text GROUP BY o.event_type) x) AS "outboxCounts",
  (SELECT coalesce(jsonb_agg(jsonb_build_object('position', a.position, 'roomId', a.room_id::text, 'roomTypeId', a.room_type_id::text, 'checkIn', a.check_in::text, 'checkOut', a.check_out::text, 'adults', a.adults, 'children', a.children, 'ratePlanId', a.rate_plan_id::text) ORDER BY a.position), '[]') FROM pms.operational_booking_assignments a WHERE a.guest_booking_id = booking.id) AS stays,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('position', n.line_position, 'serviceDate', n.stay_date::text, 'amount', n.gross_room_amount::text) ORDER BY n.line_position, n.stay_date), '[]') FROM booking.nightly_revenue_evidence n WHERE n.guest_booking_id = booking.id AND n.source_kind = 'manual' AND n.economic_event = 'room_night') AS nightly,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('addonId', a.addon_definition_id::text, 'pricingModel', a.addon_snapshot->>'pricingModel', 'unitPrice', a.addon_snapshot->'unitPrice', 'packageCount', a.quantity, 'serviceUnits', a.addon_snapshot->'serviceUnits', 'totalAmount', a.total_amount::text, 'currency', a.currency::text) ORDER BY a.id), '[]') FROM booking.booking_addon_selections a WHERE a.property_id=booking.property_id AND a.guest_booking_id = booking.id) AS "addOns",
  (SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('sourceId', source.id::text, 'position', stay.position, 'roomTypeId', stay.room_type_id::text, 'ratePlanId', stay.rate_plan_id::text, 'startMonthDay', lpad(source.season_start_month::text, 2, '0') || '-' || lpad(source.season_start_day::text, 2, '0'), 'endMonthDay', lpad(source.season_end_month::text, 2, '0') || '-' || lpad(source.season_end_day::text, 2, '0'))), '[]') FROM pms.operational_booking_assignments stay JOIN pms.recurring_pricing_source_room_values value ON value.property_id = stay.property_id AND value.room_type_id = stay.room_type_id AND value.flexible_rate_plan_id = stay.rate_plan_id AND value.source_kind = 'season' JOIN pms.recurring_pricing_sources source ON source.id = value.source_id AND source.property_id = value.property_id AND source.lifecycle = 'active' WHERE stay.guest_booking_id = booking.id) AS seasons
FROM booking.guest_bookings booking WHERE booking.id = ANY($1::uuid[]) AND booking.source_system = 'pms' AND booking.booking_metadata->>'contractVersion' = 'pms-manual-booking.v1' ORDER BY booking.id`;

export const MANUAL_BOOKING_COHORT_SQL = `SELECT id::text FROM booking.guest_bookings
WHERE property_id=ANY($1::uuid[]) AND source_system='pms'
  AND booking_metadata->>'contractVersion'='pms-manual-booking.v1'
  AND created_at <= $2::timestamptz ORDER BY id`;

// prettier-ignore
export async function runManualBookingReadiness(client: QueryExecutor, input: { manifest: unknown; manifestSha256: string; reviewedSha256: string; now?: Date }): Promise<ManualBookingReadinessReport> {
  const findings: ManualBookingReadinessFinding[] = [];
  const add = (code: string, message: string, guestBookingId: string | null = null) => findings.push({ code, guestBookingId, message });
  const mode = await client.query<{ transaction_read_only: string }>("SHOW transaction_read_only");
  if (mode.rows[0]?.transaction_read_only !== "on") throw new Error("Manual booking readiness requires a read-only transaction");
  const digestValid = /^[a-f0-9]{64}$/.test(input.manifestSha256) && input.manifestSha256 === input.reviewedSha256;
  const manifest = digestValid && validManifest(input.manifest) ? input.manifest : null;
  if (!manifest) add("EVIDENCE_MANIFEST_INVALID", "Provide a reviewed v1 manifest with snapshot, restore rehearsal, cutover review, and exact cases.");
  const rows = manifest ? (await client.query<ReadinessRow>(MANUAL_BOOKING_READINESS_SQL, [manifest.cases.map((item) => item.guestBookingId)])).rows : [];
  if (manifest) {
    const cohort = (await client.query<{ id: string }>(MANUAL_BOOKING_COHORT_SQL, [manifest.propertyIds, manifest.cutover.watermark])).rows.map(({ id }) => id).sort();
    if (JSON.stringify(cohort) !== JSON.stringify(manifest.cases.map(({ guestBookingId }) => guestBookingId).sort())) add("TARGET_COHORT_MISMATCH", "Reviewed cases do not exactly cover target manual bookings in the property/time watermark.");
    const byId = new Map(rows.map((row) => [row.guestBookingId, row]));
    for (const item of manifest.cases) {
      const row = byId.get(item.guestBookingId);
      if (!row) add("TARGET_CASE_MISSING", "Reviewed rehearsal case is absent from target v1 evidence.", item.guestBookingId);
      else if (item.scenarios.some((scenario) => LIFECYCLE_SCENARIOS.has(scenario as never))) checkLifecycle(row, item, add);
      else checkBooking(row, item, add);
    }
    checkCoverage(manifest.cases, add);
  }
  return { contractVersion: "pms-manual-booking-readiness.v1", scope: "target_typescript_v1_only", generatedAt: (input.now ?? new Date()).toISOString(), status: findings.length ? "blocked" : "ready", evidence: { runId: manifest?.runId ?? null, manifestSha256: input.manifestSha256, snapshotId: manifest?.snapshot.id ?? null, restoreRehearsalId: manifest?.restoreRehearsal.id ?? null, cutoverWatermark: manifest?.cutover.watermark ?? null, reviewedBy: manifest?.cutover.reviewedBy ?? null }, summary: { bookings: rows.length, paid: rows.filter((row) => row.paymentStatus === "paid").length, unpaid: rows.filter((row) => row.paymentStatus === "unpaid").length, refunded: rows.filter((row) => row.paymentStatus === "refunded").length, blockers: findings.length }, findings };
}

// prettier-ignore
function checkBooking(row: ReadinessRow, item: RehearsalCase, add: (code: string, message: string, id?: string) => void): void {
  const id = row.guestBookingId;
  const addOns = actualAddons(row.addOns, row.currency);
  if (row.propertyId !== item.propertyId || !row.headerValid || row.assignmentCount !== row.roomCount || row.exactAssignmentCount !== row.roomCount || row.nightlyCount !== row.expectedNightCount || row.invalidNightCount) add("STAY_EVIDENCE_MISMATCH", `Expected a property-bound confirmed header, ${row.roomCount} exact stays/${row.expectedNightCount} matching nights; found ${row.exactAssignmentCount}/${row.assignmentCount} stays, ${row.nightlyCount} nights, ${row.invalidNightCount} invalid.`, id);
  if (decimal(row.nightlyTotal) + decimal(row.addonTotal) !== decimal(row.totalAmount)) add("TOTAL_MISMATCH", `Nightly ${row.nightlyTotal} + add-ons ${row.addonTotal} does not equal total ${row.totalAmount} ${row.currency}.`, id);
  const paid = row.paymentStatus === "paid" && decimal(row.balanceAmount) === 0n && row.paymentCount === 1 && row.paymentMatchCount === 1 && decimal(row.paymentTotal) === decimal(row.totalAmount);
  const unpaid = row.paymentStatus === "unpaid" && decimal(row.balanceAmount) === decimal(row.totalAmount) && row.paymentCount === 0;
  if (!paid && !unpaid) add("SETTLEMENT_MISMATCH", `Payment state ${row.paymentStatus}, balance ${row.balanceAmount}, payments ${row.paymentCount}/${row.paymentTotal} is inconsistent.`, id);
  if (row.bookingChannel !== "direct" || !DIRECT_SOURCES.has(row.directSource ?? "") || !MANUAL_BOOKING_PAYMENT_METHODS.includes(row.expectedPaymentMethod as never) || !row.attributionValid) add("ATTRIBUTION_OR_INTENT_MISMATCH", "Canonical direct attribution or expected payment intent is missing.", id);
  if (!row.platformChainValid) add("PLATFORM_EVIDENCE_MISMATCH", "Command, created event, exact outbox set, and audit are not one causal chain.", id);
  if (row.bookerCount !== 1 || !row.guestConfirmationMatches) add("GUEST_EVIDENCE_MISMATCH", "Booker or guest-confirmation special-request evidence is incomplete.", id);
  if (!addOns) add("ADDON_SNAPSHOT_INVALID", "One or more add-on snapshots cannot reproduce their persisted totals.", id);
  if (row.privateNoteLeakCount) add("PRIVATE_NOTE_LEAK", "Private note content appears in guest confirmation evidence.", id);
  const actual = { currency: row.currency, directSource: row.directSource, expectedPaymentMethod: row.expectedPaymentMethod, paymentStatus: row.paymentStatus, totalAmount: normalized(row.totalAmount), balanceAmount: normalized(row.balanceAmount), stays: sorted(row.stays), nightly: sorted(row.nightly.map((night) => ({ ...night, amount: normalized(night.amount) }))), addOns: sorted(addOns ?? []), seasons: sorted(row.seasons) };
  const expected = { ...item.expected, totalAmount: normalized(item.expected.totalAmount), balanceAmount: normalized(item.expected.balanceAmount), stays: sorted(item.expected.stays), nightly: sorted(item.expected.nightly.map((night) => ({ ...night, amount: normalized(night.amount) }))), addOns: sorted(item.expected.addOns.map((addon) => ({ ...addon, unitPrice: { ...addon.unitPrice, amountDecimal: normalized(addon.unitPrice.amountDecimal) }, totalAmount: normalized(addon.totalAmount) }))), seasons: sorted(item.expected.seasons) };
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) add("REHEARSAL_EXPECTATION_MISMATCH", "Target facts differ from the reviewed case manifest.", id);
}

// prettier-ignore
function checkLifecycle(row: ReadinessRow, item: RehearsalCase, add: (code: string, message: string, id?: string) => void): void {
  const expected = item.expected.lifecycle!, id = row.guestBookingId, addOns = actualAddons(row.addOns, row.currency);
  if (row.propertyId !== item.propertyId || row.bookingChannel !== "direct" || !row.platformChainValid || !row.guestConfirmationMatches || !row.attributionValid || row.bookerCount !== 1 || row.privateNoteLeakCount || !addOns) add("BASE_EVIDENCE_MISMATCH", "Lifecycle rehearsal lost its property-bound creation, guest, add-on, attribution, or causal evidence.", id);
  const actual = { kind: expected.kind, currency: row.currency, directSource: row.directSource, expectedPaymentMethod: row.expectedPaymentMethod, addOns: sorted(addOns ?? []), lifecycleStatus: row.lifecycleStatus, paymentStatus: row.paymentStatus, totalAmount: normalized(row.totalAmount), balanceAmount: normalized(row.balanceAmount), assignmentStatuses: row.assignmentStatuses, roomIds: row.roomIds, occupiedRoomNights: row.occupiedRoomNights, revenueTotal: normalized(row.revenueTotal), refundTotal: normalized(row.refundTotal), eventCounts: row.eventCounts, operationCounts: row.operationCounts, auditCounts: row.auditCounts, outboxCounts: row.outboxCounts };
  const normalizedExpected = { ...expected, currency: item.expected.currency, directSource: item.expected.directSource, expectedPaymentMethod: item.expected.expectedPaymentMethod, addOns: sorted(item.expected.addOns.map((addon) => ({ ...addon, unitPrice: { ...addon.unitPrice, amountDecimal: normalized(addon.unitPrice.amountDecimal) }, totalAmount: normalized(addon.totalAmount) }))), totalAmount: normalized(expected.totalAmount), balanceAmount: normalized(expected.balanceAmount), revenueTotal: normalized(expected.revenueTotal), refundTotal: normalized(expected.refundTotal) };
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(normalizedExpected))) add("LIFECYCLE_EVIDENCE_MISMATCH", `${expected.kind} facts differ from the reviewed lifecycle result.`, id);
}

// prettier-ignore
function checkCoverage(cases: RehearsalCase[], add: (code: string, message: string, id?: string) => void): void {
  const variants = new Set(cases.map((item) => `${item.expected.expectedPaymentMethod}:${item.expected.paymentStatus}`));
  for (const method of MANUAL_BOOKING_PAYMENT_METHODS)
    for (const status of ["paid", "unpaid"]) if (!variants.has(`${method}:${status}`)) add("PAYMENT_VARIANT_MISSING", `Missing reviewed case ${method}:${status}.`);
  const scenarios = new Set(cases.flatMap((item) => item.scenarios));
  for (const scenario of REQUIRED_SCENARIOS) if (!scenarios.has(scenario)) add("SCENARIO_MISSING", `Missing reviewed ${scenario} case.`);
  const models = new Set(cases.flatMap((item) => item.expected.addOns.map((addon) => addon.pricingModel)));
  for (const model of MANUAL_BOOKING_ADDON_MODELS) if (!models.has(model)) add("ADDON_MODEL_CASE_MISSING", `Missing reviewed ${model} add-on case.`);
  for (const item of cases) {
    if (item.scenarios.includes("custom_rate") && !item.expected.stays.some((stay) => stay.ratePlanId === null)) add("SCENARIO_INVALID", "Custom-rate case has no custom stay.", item.guestBookingId);
    if (item.scenarios.includes("cross_season") && !item.expected.seasons.some((season) => { const stay = item.expected.stays.find((candidate) => candidate.position === season.position && candidate.roomTypeId === season.roomTypeId && candidate.ratePlanId === season.ratePlanId), nights = item.expected.nightly.filter((night) => night.position === season.position), dates = nights.map((night) => night.serviceDate.slice(5)); return !!stay && dates.some((day) => inSeason(day, season)) && dates.some((day) => !inSeason(day, season)) && new Set(nights.map((night) => normalized(night.amount))).size > 1; })) add("SCENARIO_INVALID", "No reviewed rate-plan stay crosses its matched active season boundary with a price transition.", item.guestBookingId);
    if (item.scenarios.includes("heterogeneous_dates") && new Set(item.expected.stays.map((stay) => `${stay.checkIn}/${stay.checkOut}`)).size < 2) add("SCENARIO_INVALID", "Heterogeneous-date case has one stay window.", item.guestBookingId);
    if (item.scenarios.includes("email_source") && item.expected.directSource !== "email") add("SCENARIO_INVALID", "Email-source case does not expect Email attribution.", item.guestBookingId);
    const lifecycle = item.scenarios.filter((scenario) => LIFECYCLE_SCENARIOS.has(scenario as never)), scenario = lifecycle[0], result = item.expected.lifecycle, kind = scenario?.endsWith("_refund") ? "refund" : scenario;
    if ((lifecycle.length && (lifecycle.length !== 1 || result?.kind !== kind)) || (!lifecycle.length && result)) add("SCENARIO_INVALID", "Lifecycle case must carry one matching reviewed lifecycle result.", item.guestBookingId);
    if (scenario?.endsWith("_refund") && (item.expected.paymentStatus !== "paid" || decimal(item.expected.balanceAmount) !== 0n || result?.paymentStatus !== (scenario === "full_refund" ? "refunded" : "paid") || decimal(result.refundTotal) <= 0n || (scenario === "partial_refund" ? decimal(result.refundTotal) >= decimal(item.expected.totalAmount) : decimal(result.refundTotal) !== decimal(item.expected.totalAmount)))) add("SCENARIO_INVALID", "Refund cases must start paid and prove exact partial/full results.", item.guestBookingId);
  }
}

// prettier-ignore
function validManifest(value: unknown): value is ManualBookingEvidenceManifest {
  const input = record(value);
  if (input?.["contractVersion"] !== "pms-manual-booking-rehearsal.v1" || !text(input["runId"])) return false;
  const snapshot = record(input["snapshot"]), restore = record(input["restoreRehearsal"]), cutover = record(input["cutover"]), cases = input["cases"], properties = input["propertyIds"];
  if (!Array.isArray(properties) || !properties.length || !properties.every(uuid) || new Set(properties).size !== properties.length || !text(snapshot?.["id"]) || !date(snapshot?.["capturedAt"]) || !text(restore?.["id"]) || restore?.["status"] !== "passed" || !date(restore["completedAt"]) || !date(cutover?.["watermark"]) || !text(cutover?.["reviewedBy"]) || !date(cutover?.["reviewedAt"]) || Date.parse(String(cutover["watermark"])) > Date.parse(String(snapshot["capturedAt"])) || Date.parse(String(snapshot["capturedAt"])) > Date.parse(String(restore["completedAt"])) || Date.parse(String(restore["completedAt"])) > Date.parse(String(cutover["reviewedAt"])) || !Array.isArray(cases) || !cases.length) return false;
  const ids = new Set<string>();
  return cases.every((raw) => {
    const item = record(raw), expected = record(item?.["expected"]);
    const id = item?.["guestBookingId"];
    if (!uuid(id) || ids.has(id) || !uuid(item?.["propertyId"]) || !properties.includes(item["propertyId"]) || !Array.isArray(item?.["scenarios"]) || !item["scenarios"].every((scenario) => text(scenario) && REQUIRED_SCENARIOS.includes(scenario as never)) || !validExpected(expected) || (item["scenarios"].some((scenario) => LIFECYCLE_SCENARIOS.has(scenario as never)) && !expected?.["lifecycle"])) return false;
    ids.add(id);
    return true;
  });
}

// prettier-ignore
function validExpected(value: Record<string, unknown> | null): boolean {
  if (!value || !text(value["currency"]) || !DIRECT_SOURCES.has(String(value["directSource"])) || !MANUAL_BOOKING_PAYMENT_METHODS.includes(value["expectedPaymentMethod"] as never) || !["paid", "unpaid"].includes(String(value["paymentStatus"])) || !money(value["totalAmount"]) || !money(value["balanceAmount"])) return false;
  const stays = value["stays"], nights = value["nightly"], addons = value["addOns"], seasons = value["seasons"];
  return Array.isArray(stays) && stays.length > 0 && stays.every((raw) => { const row = record(raw); return Number.isInteger(row?.["position"]) && uuid(row?.["roomId"]) && uuid(row?.["roomTypeId"]) && dateOnly(row?.["checkIn"]) && dateOnly(row?.["checkOut"]) && String(row?.["checkIn"]) < String(row?.["checkOut"]) && Number.isInteger(row?.["adults"]) && Number(row?.["adults"]) > 0 && Number.isInteger(row?.["children"]) && Number(row?.["children"]) >= 0 && (row?.["ratePlanId"] === null || uuid(row?.["ratePlanId"])); }) && Array.isArray(nights) && nights.length > 0 && nights.every((raw) => { const row = record(raw); return Number.isInteger(row?.["position"]) && dateOnly(row?.["serviceDate"]) && money(row?.["amount"]); }) && Array.isArray(addons) && addons.every((addon) => validAddon(addon, String(value["currency"]))) && Array.isArray(seasons) && seasons.every((raw) => { const row = record(raw); return uuid(row?.["sourceId"]) && Number.isInteger(row?.["position"]) && uuid(row?.["roomTypeId"]) && uuid(row?.["ratePlanId"]) && monthDay(row?.["startMonthDay"]) && monthDay(row?.["endMonthDay"]); }) && (value["lifecycle"] === undefined || validLifecycle(value["lifecycle"]));
}

function validAddon(raw: unknown, currency: string): boolean {
  const row = record(raw),
    price = record(row?.["unitPrice"]),
    units = row?.["serviceUnits"],
    model = row?.["pricingModel"];
  if (
    !uuid(row?.["addonId"]) ||
    !MANUAL_BOOKING_ADDON_MODELS.includes(model as never) ||
    !money(price?.["amountDecimal"]) ||
    price?.["currency"] !== currency ||
    !Number.isInteger(row?.["packageCount"]) ||
    Number(row?.["packageCount"]) < 1 ||
    !Array.isArray(units) ||
    row?.["currency"] !== currency ||
    !money(row?.["totalAmount"])
  )
    return false;
  const parsed = units.map(record);
  const uniqueDates = new Set(parsed.map((unit) => unit?.["serviceDate"])).size === parsed.length;
  if (model === "per_stay")
    return (
      parsed.length === 1 &&
      parsed[0]?.["serviceDate"] === null &&
      parsed[0]?.["guestCount"] === null
    );
  if (model === "per_guest")
    return (
      parsed.length === 1 &&
      parsed[0]?.["serviceDate"] === null &&
      Number.isInteger(parsed[0]?.["guestCount"]) &&
      Number(parsed[0]?.["guestCount"]) > 0
    );
  if (model === "per_night")
    return (
      parsed.length > 0 &&
      uniqueDates &&
      parsed.every((unit) => dateOnly(unit?.["serviceDate"]) && unit?.["guestCount"] === null)
    );
  return (
    parsed.length > 0 &&
    uniqueDates &&
    parsed.every(
      (unit) =>
        dateOnly(unit?.["serviceDate"]) &&
        Number.isInteger(unit?.["guestCount"]) &&
        Number(unit?.["guestCount"]) > 0,
    )
  );
}

// prettier-ignore
function validLifecycle(raw: unknown): boolean {
  const row = record(raw), kind = String(row?.["kind"]), operation = kind === "no_show" ? "no_show_command" : `manual_${kind}_command`, action = kind === "no_show" ? "pms.no_show" : `pms.manual_${kind}`;
  return !!row && ["cancellation", "no_show", "refund", "stay_correction", "price_correction"].includes(kind) && text(row["lifecycleStatus"]) && ["paid", "unpaid", "refunded"].includes(String(row["paymentStatus"])) && money(row["totalAmount"]) && money(row["balanceAmount"]) && Array.isArray(row["assignmentStatuses"]) && row["assignmentStatuses"].every(text) && Array.isArray(row["roomIds"]) && row["roomIds"].every((id) => id === null || uuid(id)) && Number.isInteger(row["occupiedRoomNights"]) && money(row["revenueTotal"]) && money(row["refundTotal"]) && ["eventCounts", "operationCounts", "auditCounts", "outboxCounts"].every((key) => countMap(row[key])) && Number(record(row["operationCounts"])?.[operation]) > 0 && Number(record(row["auditCounts"])?.[action]) > 0 && (kind !== "refund" || Number(record(row["auditCounts"])?.["finance.manual_booking_refund"]) > 0);
}

// prettier-ignore
function actualAddons(raw: unknown, currency: string): ExpectedAddon[] | null {
  if (!Array.isArray(raw) || !raw.every((item) => validAddon(item, currency))) return null; const addons = raw as ExpectedAddon[];
  return addons.every((addon) => decimal(addon.totalAmount) === decimal(addon.unitPrice.amountDecimal) * BigInt(addon.packageCount) * BigInt(addon.pricingModel === "per_stay" ? 1 : addon.pricingModel === "per_night" ? addon.serviceUnits.length : addon.serviceUnits.reduce((sum, unit) => sum + (unit.guestCount ?? 0), 0))) ? addons.map((addon) => ({ ...addon, unitPrice: { ...addon.unitPrice, amountDecimal: normalized(addon.unitPrice.amountDecimal) }, totalAmount: normalized(addon.totalAmount) })) : null;
}

// prettier-ignore
const countMap = (value: unknown) => { const row = record(value); return !!row && Object.values(row).every((count) => Number.isInteger(count) && Number(count) >= 0); };

const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const date = (value: unknown) => text(value) && !Number.isNaN(Date.parse(value));
const dateOnly = (value: unknown) =>
  text(value) &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const monthDay = (value: unknown) => text(value) && dateOnly(`2024-${value}`);
const uuid = (value: unknown): value is string =>
  text(value) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const money = (value: unknown) => text(value) && /^\d+(?:\.\d{1,4})?$/.test(value);
const decimal = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
};
const normalized = (value: string) => {
  const amount = decimal(value);
  return `${amount / 10_000n}.${String(amount % 10_000n).padStart(4, "0")}`;
};
const sorted = <T>(values: T[]) =>
  [...values].sort((left, right) =>
    JSON.stringify(canonical(left)).localeCompare(JSON.stringify(canonical(right))),
  );
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonical(nested)]),
        )
      : value;
const inSeason = (day: string, season: ExpectedSeason) =>
  season.startMonthDay <= season.endMonthDay
    ? day >= season.startMonthDay && day <= season.endMonthDay
    : day >= season.startMonthDay || day <= season.endMonthDay;
