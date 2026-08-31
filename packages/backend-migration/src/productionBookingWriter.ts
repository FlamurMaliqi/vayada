import type pg from "pg";

import type {
  BookingTargetRecord,
  ProductionMigrationSourceLink,
} from "./productionBookingTypes.js";

type QueryClient = Pick<pg.ClientBase, "query">;
type Column = readonly [jsonKey: string, sqlName: string, type: string];
type WriterDefinition = {
  table: string;
  key: string;
  mutable: boolean;
  columns: readonly Column[];
};
const c = (jsonKey: string, sqlName: string, type: string): Column => [jsonKey, sqlName, type];
const commonTimes = [
  c("createdAt", "created_at", "timestamptz"),
  c("updatedAt", "updated_at", "timestamptz"),
] as const;
const WRITE_ORDER = [
  "booking_settings",
  "addon_definitions",
  "promo_definitions",
  "quote_sessions",
  "checkout_contexts",
  "guest_bookings",
  "booking_guests",
  "booking_addon_selections",
  "promo_applications",
  "booking_status_events",
  "booking_change_requests",
  "direct_booking_summary_read_model",
  "product_audit_events",
];

const WRITERS: Record<string, WriterDefinition> = {
  booking_settings: {
    table: "booking.booking_settings",
    key: "property_id",
    mutable: true,
    columns: [
      c("propertyId", "property_id", "uuid"),
      c("showAddonsStep", "show_addons_step", "boolean"),
      c("groupAddonsByCategory", "group_addons_by_category", "boolean"),
      c("specialRequestsEnabled", "special_requests_enabled", "boolean"),
      c("arrivalTimeEnabled", "arrival_time_enabled", "boolean"),
      c("guestCountEnabled", "guest_count_enabled", "boolean"),
      c("phoneRequired", "phone_required", "boolean"),
      c("adultAgeThreshold", "adult_age_threshold", "integer"),
      c("childrenEnabled", "children_enabled", "boolean"),
      c("benefits", "benefits", "jsonb"),
      c("defaultCurrency", "default_currency", "text"),
      c("defaultLanguage", "default_language", "text"),
      c("supportedCurrencies", "supported_currencies", "text[]"),
      c("supportedLanguages", "supported_languages", "text[]"),
      c("bookingFilters", "booking_filters", "jsonb"),
      c("customFilters", "custom_filters", "jsonb"),
      c("filterRooms", "filter_rooms", "jsonb"),
      c("sourceFreshness", "source_freshness", "jsonb"),
      c("headerLogoMediaObjectId", "header_logo_media_object_id", "uuid"),
      c("heroImageUrl", "hero_image_url", "text"),
      c("primaryColor", "primary_color", "text"),
      c("fontPairing", "font_pairing", "text"),
      c("acceptanceMode", "acceptance_mode", "text"),
      c("updatedAt", "updated_at", "timestamptz"),
    ],
  },
  addon_definitions: {
    table: "booking.addon_definitions",
    key: "id",
    mutable: true,
    columns: [
      c("id", "id", "uuid"),
      c("propertyId", "property_id", "uuid"),
      c("sourceSystem", "source_system", "text"),
      c("sourceAddonId", "source_addon_id", "text"),
      c("name", "name", "text"),
      c("description", "description", "text"),
      c("category", "category", "text"),
      c("pricingModel", "pricing_model", "text"),
      c("priceAmount", "price_amount", "numeric"),
      c("currency", "currency", "text"),
      c("publicVisible", "public_visible", "boolean"),
      c("status", "status", "text"),
      c("metadata", "metadata", "jsonb"),
      ...commonTimes,
    ],
  },
  promo_definitions: {
    table: "booking.promo_definitions",
    key: "id",
    mutable: true,
    columns: [
      c("id", "id", "uuid"),
      c("propertyId", "property_id", "uuid"),
      c("sourceSystem", "source_system", "text"),
      c("sourcePromoId", "source_promo_id", "text"),
      c("code", "code", "text"),
      c("discountType", "discount_type", "text"),
      c("discountValue", "discount_value", "numeric"),
      c("validFrom", "valid_from", "date"),
      c("validUntil", "valid_until", "date"),
      c("isActive", "is_active", "boolean"),
      c("maxUses", "max_uses", "integer"),
      c("currentUses", "current_uses", "integer"),
      c("status", "status", "text"),
      c("minBookingValue", "min_booking_value", "numeric"),
      c("applicableRoomIds", "applicable_room_ids", "uuid[]"),
      c("stayDateFrom", "stay_date_from", "date"),
      c("stayDateUntil", "stay_date_until", "date"),
      c("metadata", "metadata", "jsonb"),
      ...commonTimes,
    ],
  },
  quote_sessions: {
    table: "booking.quote_sessions",
    key: "id",
    mutable: true,
    columns: [
      c("id", "id", "uuid"),
      c("propertyId", "property_id", "uuid"),
      c("requestHash", "request_hash", "text"),
      c("publicQuoteReference", "public_quote_reference", "text"),
      c("requestedCheckIn", "requested_check_in", "date"),
      c("requestedCheckOut", "requested_check_out", "date"),
      c("adults", "adults", "integer"),
      c("children", "children", "integer"),
      c("requestedRoomCount", "requested_room_count", "integer"),
      c("currency", "currency", "text"),
      c("status", "status", "text"),
      c("selectedOfferSnapshot", "selected_offer_snapshot", "jsonb"),
      c("totals", "totals", "jsonb"),
      c("unavailableReasons", "unavailable_reasons", "text[]"),
      c("policySnapshot", "policy_snapshot", "jsonb"),
      c("sourceFreshness", "source_freshness", "jsonb"),
      c("promoCode", "promo_code", "text"),
      c("referralCode", "referral_code", "text"),
      c("expiresAt", "expires_at", "timestamptz"),
      ...commonTimes,
    ],
  },
  checkout_contexts: {
    table: "booking.checkout_contexts",
    key: "id",
    mutable: true,
    columns: [
      c("id", "id", "uuid"),
      c("quoteSessionId", "quote_session_id", "uuid"),
      c("propertyId", "property_id", "uuid"),
      c("locale", "locale", "text"),
      c("currency", "currency", "text"),
      c("status", "status", "text"),
      c("guestInput", "guest_input", "jsonb"),
      c("selectedAddons", "selected_addons", "jsonb"),
      c("paymentContext", "payment_context", "jsonb"),
      c("promoContext", "promo_context", "jsonb"),
      c("piiRetentionUntil", "pii_retention_until", "date"),
      c("expiresAt", "expires_at", "timestamptz"),
      ...commonTimes,
    ],
  },
  guest_bookings: {
    table: "booking.guest_bookings",
    key: "id",
    mutable: true,
    columns: [
      c("id", "id", "uuid"),
      c("propertyId", "property_id", "uuid"),
      c("quoteSessionId", "quote_session_id", "uuid"),
      c("checkoutContextId", "checkout_context_id", "uuid"),
      c("publicReference", "public_reference", "text"),
      c("sourceSystem", "source_system", "text"),
      c("sourceBookingId", "source_booking_id", "text"),
      c("lifecycleStatus", "lifecycle_status", "text"),
      c("paymentStatus", "payment_status", "text"),
      c("checkIn", "check_in", "date"),
      c("checkOut", "check_out", "date"),
      c("adults", "adults", "integer"),
      c("children", "children", "integer"),
      c("roomCount", "room_count", "integer"),
      c("currency", "currency", "text"),
      c("totalAmount", "total_amount", "numeric"),
      c("balanceAmount", "balance_amount", "numeric"),
      c("cancellationReason", "cancellation_reason", "text"),
      c("bookingMetadata", "booking_metadata", "jsonb"),
      c("expectedPaymentMethod", "expected_payment_method", "text"),
      c("billingPlanSnapshot", "billing_plan_snapshot", "text"),
      c("commissionTermsSnapshot", "commission_terms_snapshot", "jsonb"),
      c("financeTermsCapturedAt", "finance_terms_captured_at", "timestamptz"),
      c("bookingChannel", "booking_channel", "text"),
      c("directBookingSource", "direct_booking_source", "text"),
      ...commonTimes,
    ],
  },
  booking_guests: {
    table: "booking.booking_guests",
    key: "id",
    mutable: true,
    columns: [
      c("id", "id", "uuid"),
      c("guestBookingId", "guest_booking_id", "uuid"),
      c("guestRole", "guest_role", "text"),
      c("firstName", "first_name", "text"),
      c("lastName", "last_name", "text"),
      c("email", "email", "text"),
      c("phone", "phone", "text"),
      c("countryCode", "country_code", "text"),
      c("countryCodeRaw", "country_code_raw", "text"),
      c("countryCodeReviewRequired", "country_code_review_required", "boolean"),
      c("arrivalTime", "arrival_time", "text"),
      c("specialRequests", "special_requests", "text"),
      c("piiRetentionUntil", "pii_retention_until", "date"),
      ...commonTimes,
    ],
  },
  booking_addon_selections: {
    table: "booking.booking_addon_selections",
    key: "id",
    mutable: false,
    columns: [
      c("id", "id", "uuid"),
      c("propertyId", "property_id", "uuid"),
      c("guestBookingId", "guest_booking_id", "uuid"),
      c("quoteSessionId", "quote_session_id", "uuid"),
      c("addonDefinitionId", "addon_definition_id", "uuid"),
      c("addonSnapshot", "addon_snapshot", "jsonb"),
      c("quantity", "quantity", "integer"),
      c("serviceDate", "service_date", "date"),
      c("totalAmount", "total_amount", "numeric"),
      c("currency", "currency", "text"),
      c("createdAt", "created_at", "timestamptz"),
    ],
  },
  promo_applications: {
    table: "booking.promo_applications",
    key: "id",
    mutable: false,
    columns: [
      c("id", "id", "uuid"),
      c("propertyId", "property_id", "uuid"),
      c("quoteSessionId", "quote_session_id", "uuid"),
      c("guestBookingId", "guest_booking_id", "uuid"),
      c("promoDefinitionId", "promo_definition_id", "uuid"),
      c("promoCode", "promo_code", "text"),
      c("applicationStatus", "application_status", "text"),
      c("discountAmount", "discount_amount", "numeric"),
      c("currency", "currency", "text"),
      c("metadata", "metadata", "jsonb"),
      c("createdAt", "created_at", "timestamptz"),
    ],
  },
  booking_status_events: {
    table: "booking.booking_status_events",
    key: "id",
    mutable: false,
    columns: [
      c("id", "id", "uuid"),
      c("guestBookingId", "guest_booking_id", "uuid"),
      c("eventType", "event_type", "text"),
      c("fromStatus", "from_status", "text"),
      c("toStatus", "to_status", "text"),
      c("actorType", "actor_type", "text"),
      c("actorUserId", "actor_user_id", "uuid"),
      c("publicVisible", "public_visible", "boolean"),
      c("publicMessage", "public_message", "text"),
      c("eventPayload", "event_payload", "jsonb"),
      c("occurredAt", "occurred_at", "timestamptz"),
      c("createdAt", "created_at", "timestamptz"),
    ],
  },
  booking_change_requests: {
    table: "booking.booking_change_requests",
    key: "id",
    mutable: true,
    columns: [
      c("id", "id", "uuid"),
      c("guestBookingId", "guest_booking_id", "uuid"),
      c("requestType", "request_type", "text"),
      c("requestedBy", "requested_by", "text"),
      c("status", "status", "text"),
      c("requestedChanges", "requested_changes", "jsonb"),
      c("decisionActorUserId", "decision_actor_user_id", "uuid"),
      c("decisionNote", "decision_note", "text"),
      c("decidedAt", "decided_at", "timestamptz"),
      ...commonTimes,
    ],
  },
  direct_booking_summary_read_model: {
    table: "booking.direct_booking_summary_read_model",
    key: "guest_booking_id",
    mutable: true,
    columns: [
      c("guestBookingId", "guest_booking_id", "uuid"),
      c("propertyId", "property_id", "uuid"),
      c("publicReference", "public_reference", "text"),
      c("lifecycleStatus", "lifecycle_status", "text"),
      c("paymentStatus", "payment_status", "text"),
      c("checkIn", "check_in", "date"),
      c("checkOut", "check_out", "date"),
      c("guestCounts", "guest_counts", "jsonb"),
      c("roomSummary", "room_summary", "jsonb"),
      c("amountSummary", "amount_summary", "jsonb"),
      c("publicPolicy", "public_policy", "jsonb"),
      c("sourceFreshness", "source_freshness", "jsonb"),
      c("projectedAt", "projected_at", "timestamptz"),
    ],
  },
  product_audit_events: {
    table: "platform.product_audit_events",
    key: "id",
    mutable: false,
    columns: [
      c("id", "id", "uuid"),
      c("auditKey", "audit_key", "text"),
      c("product", "product", "text"),
      c("action", "action", "text"),
      c("occurredAt", "occurred_at", "timestamptz"),
      c("tenantScope", "tenant_scope", "text"),
      c("propertyId", "property_id", "uuid"),
      c("actorType", "actor_type", "text"),
      c("targetResourceProduct", "target_resource_product", "text"),
      c("targetResourceType", "target_resource_type", "text"),
      c("targetResourceId", "target_resource_id", "text"),
      c("correlationId", "correlation_id", "text"),
      c("redactedPayload", "redacted_payload", "jsonb"),
      c("privatePayload", "private_payload", "jsonb"),
      c("auditMetadata", "audit_metadata", "jsonb"),
      c("retentionClass", "retention_class", "text"),
      c("privacyScope", "privacy_scope", "text"),
      c("aiVisible", "ai_visible", "boolean"),
    ],
  },
};

export async function writeProductionBookingRecords(
  client: QueryClient,
  records: BookingTargetRecord[],
): Promise<Record<string, number>> {
  const grouped = new Map<string, BookingTargetRecord[]>();
  for (const record of records)
    grouped.set(record.targetTable, [...(grouped.get(record.targetTable) ?? []), record]);
  const counts: Record<string, number> = {};
  for (const [targetTable, rows] of [...grouped].sort(
    ([left], [right]) => WRITE_ORDER.indexOf(left) - WRITE_ORDER.indexOf(right),
  )) {
    const definition = WRITERS[targetTable];
    if (!definition) throw new Error(`Unsupported Booking writer ${targetTable}`);
    const aliases = definition.columns
      .map(([jsonKey, , type]) => `"${jsonKey}" ${type}`)
      .join(", ");
    const names = definition.columns.map(([, sqlName]) => sqlName).join(", ");
    const values = definition.columns.map(([jsonKey]) => `source."${jsonKey}"`).join(", ");
    const updates = definition.columns
      .filter(([, sqlName]) => sqlName !== definition.key && sqlName !== "created_at")
      .map(([, sqlName]) => `${sqlName} = EXCLUDED.${sqlName}`)
      .join(", ");
    const conflict = definition.mutable
      ? `ON CONFLICT (${definition.key}) DO UPDATE SET ${updates}`
      : `ON CONFLICT (${definition.key}) DO NOTHING`;
    const result = await client.query(
      `INSERT INTO ${definition.table} (${names})
       SELECT ${values} FROM jsonb_to_recordset($1::jsonb) AS source(${aliases})
       ${conflict}`,
      [JSON.stringify(rows.map((row) => row.row))],
    );
    counts[targetTable] = result.rowCount ?? 0;
  }
  return counts;
}

export async function writeProductionMigrationProvenance(
  client: QueryClient,
  links: ProductionMigrationSourceLink[],
  sourceRunId: string,
): Promise<number> {
  if (!links.length) return 0;
  const result = await client.query(
    `INSERT INTO platform.production_migration_source_links
       (source_database, source_table, source_id, target_product, target_table, target_id,
        first_run_id, last_run_id, source_checksum, source_updated_at)
     SELECT source."sourceDatabase", source."sourceTable", source."sourceId",
            source."targetProduct", source."targetTable", source."targetId",
            $2, $2, source."sourceChecksum", source."sourceUpdatedAt"
     FROM jsonb_to_recordset($1::jsonb) AS source(
       "sourceDatabase" text, "sourceTable" text, "sourceId" text,
       "targetProduct" text, "targetTable" text, "targetId" text,
       "sourceChecksum" text, "sourceUpdatedAt" timestamptz
     )
     ON CONFLICT (source_database, source_table, source_id, target_product, target_table, target_id)
     DO UPDATE SET last_run_id = EXCLUDED.last_run_id,
                   source_checksum = EXCLUDED.source_checksum,
                   source_updated_at = EXCLUDED.source_updated_at,
                   last_migrated_at = now()`,
    [JSON.stringify(links), sourceRunId],
  );
  return result.rowCount ?? 0;
}
