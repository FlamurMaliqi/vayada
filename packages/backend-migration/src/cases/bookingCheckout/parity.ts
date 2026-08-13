import type pg from "pg";

import type { ExpectedTarget, ParityFinding, ParityHandlerContext } from "../../parityTypes.js";

type BookingFlowCheck = NonNullable<ExpectedTarget["bookingCheckoutChecks"]>["flows"][number];
type BookingSettingsCheck = NonNullable<
  NonNullable<ExpectedTarget["bookingCheckoutChecks"]>["settings"]
>[number];

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJsonValue(actual: unknown, expected: unknown): boolean {
  return stableJson(actual) === stableJson(expected);
}

async function checkBookingFlow(
  client: pg.Client,
  flow: BookingFlowCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    quote_status: string;
    checkout_status: string;
    lifecycle_status: string;
    payment_status: string;
    public_quote_reference: string;
    public_booking_reference: string;
    payment_id: string | null;
    payment_amount: string | null;
    payment_currency: string | null;
    payment_organization_id: string | null;
    payment_row_status: string | null;
    payment_booking_id: string | null;
    summary_reference: string | null;
    summary_lifecycle_status: string | null;
    summary_payment_status: string | null;
    summary_total: string | null;
    summary_currency: string | null;
    booker_country_code: string | null;
    booker_country_code_raw: string | null;
    booker_country_code_review_required: boolean | null;
  }>(
    `SELECT
       q.status AS quote_status,
       c.status AS checkout_status,
       b.lifecycle_status,
       b.payment_status,
       q.public_quote_reference,
       b.public_reference AS public_booking_reference,
       p.id::text AS payment_id,
       p.amount::text AS payment_amount,
       p.currency AS payment_currency,
       p.organization_id::text AS payment_organization_id,
       p.status AS payment_row_status,
       p.guest_booking_id::text AS payment_booking_id,
       rm.public_reference AS summary_reference,
       rm.lifecycle_status AS summary_lifecycle_status,
       rm.payment_status AS summary_payment_status,
       rm.amount_summary ->> 'total' AS summary_total,
       rm.amount_summary ->> 'currency' AS summary_currency,
       BTRIM(booker.country_code) AS booker_country_code,
       booker.country_code_raw AS booker_country_code_raw,
       booker.country_code_review_required AS booker_country_code_review_required
     FROM booking.quote_sessions q
     JOIN booking.checkout_contexts c
       ON c.quote_session_id = q.id
      AND c.property_id = q.property_id
     JOIN booking.guest_bookings b
       ON b.quote_session_id = q.id
      AND b.checkout_context_id = c.id
      AND b.property_id = q.property_id
     LEFT JOIN finance.payments p
       ON p.id = $5
      AND p.guest_booking_id = b.id
      AND p.property_id = b.property_id
     LEFT JOIN booking.direct_booking_summary_read_model rm
       ON rm.guest_booking_id = b.id
      AND rm.property_id = b.property_id
     LEFT JOIN booking.booking_guests booker
       ON booker.guest_booking_id = b.id
      AND booker.guest_role = 'booker'
     WHERE q.id = $1
       AND c.id = $2
       AND b.id = $3
       AND q.property_id = $4`,
    [
      flow.quoteSessionId,
      flow.checkoutContextId,
      flow.guestBookingId,
      flow.propertyId,
      flow.paymentId,
    ],
  );

  const row = result.rows[0];
  const matches =
    row &&
    row.quote_status === "converted" &&
    row.checkout_status === "converted" &&
    row.lifecycle_status === flow.lifecycleStatus &&
    row.payment_status === flow.paymentStatus &&
    row.public_quote_reference === flow.publicQuoteReference &&
    row.public_booking_reference === flow.publicBookingReference &&
    row.payment_id === flow.paymentId &&
    row.payment_amount === flow.paymentAmount &&
    row.payment_currency === flow.currency &&
    row.payment_organization_id === flow.organizationId &&
    row.payment_row_status === "paid" &&
    row.payment_booking_id === flow.guestBookingId &&
    row.summary_reference === flow.publicBookingReference &&
    row.summary_lifecycle_status === flow.lifecycleStatus &&
    row.summary_payment_status === flow.paymentStatus &&
    row.summary_total === flow.paymentAmount &&
    row.summary_currency === flow.currency &&
    row.booker_country_code === flow.bookerCountryCode &&
    row.booker_country_code_raw === flow.bookerCountryCodeRaw &&
    row.booker_country_code_review_required === flow.bookerCountryCodeReviewRequired;

  if (!matches) {
    findings.push({
      severity: "fail",
      code: "BOOKING_CHECKOUT_FLOW_MISMATCH",
      owner: "Booking checkout",
      targetObject: "booking.guest_bookings",
      message: `Expected converted quote/checkout/booking/payment flow ${flow.guestBookingId} was not found`,
      expected:
        "Converted quote and checkout, confirmed paid booking, matching finance payment, and matching summary read-model",
      actual: row ? JSON.stringify(row) : "row missing",
      suggestedAction:
        "Check booking checkout fixture rows and target relationship preservation for quote/session/payment linkage.",
    });
  }
}

async function checkOwnershipLink(
  client: pg.Client,
  flow: BookingFlowCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM identity.organization_resource_links link
       JOIN identity.product_entitlements entitlement
         ON entitlement.organization_id = link.organization_id
        AND entitlement.product = 'booking'
        AND entitlement.entitlement_key = 'booking-engine'
        AND entitlement.status = 'active'
       JOIN hotel_catalog.property_source_links source
         ON source.source_system = 'booking'
        AND source.source_table = 'booking_hotels'
        AND source.source_id = link.resource_id
        AND source.relationship = 'canonical_input'
        AND source.property_id = $3
       WHERE link.organization_id = $1
         AND link.product = 'booking'
         AND link.resource_type = 'booking_hotel'
         AND link.resource_id = $2
         AND link.relationship = 'owner'
         AND link.status = 'active'
     ) AS exists`,
    [flow.organizationId, flow.bookingHotelResourceId, flow.propertyId],
  );

  if (!result.rows[0].exists) {
    findings.push({
      severity: "fail",
      code: "BOOKING_CHECKOUT_OWNERSHIP_LINK_MISMATCH",
      owner: "Booking checkout",
      targetObject: "identity.organization_resource_links",
      message: `Expected booking hotel ${flow.bookingHotelResourceId} to link organization ${flow.organizationId} to property ${flow.propertyId}`,
      expected:
        "Active booking hotel owner resource link, active booking-engine entitlement, and catalog source link for the same booking hotel",
      actual: "relationship not found",
      suggestedAction:
        "Check tenant/resource ownership backfill before accepting checkout rows for the property.",
    });
  }
}

async function checkRelatedCounts(
  client: pg.Client,
  flow: BookingFlowCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    guest_count: string;
    addon_selection_count: string;
    promo_application_count: string;
    status_event_count: string;
  }>(
    `SELECT
       (SELECT count(*)::text
        FROM booking.booking_guests
        WHERE guest_booking_id = $1) AS guest_count,
       (SELECT count(*)::text
        FROM booking.booking_addon_selections
        WHERE guest_booking_id = $1
          AND property_id = $2) AS addon_selection_count,
       (SELECT count(*)::text
        FROM booking.promo_applications
        WHERE guest_booking_id = $1
          AND property_id = $2) AS promo_application_count,
       (SELECT count(*)::text
        FROM booking.booking_status_events
        WHERE guest_booking_id = $1) AS status_event_count`,
    [flow.guestBookingId, flow.propertyId],
  );

  const row = result.rows[0];
  const actual = {
    guestCount: parseInt(row.guest_count, 10),
    addonSelectionCount: parseInt(row.addon_selection_count, 10),
    promoApplicationCount: parseInt(row.promo_application_count, 10),
    statusEventCount: parseInt(row.status_event_count, 10),
  };

  if (
    actual.guestCount !== flow.guestCount ||
    actual.addonSelectionCount !== flow.addonSelectionCount ||
    actual.promoApplicationCount !== flow.promoApplicationCount ||
    actual.statusEventCount !== flow.statusEventCount
  ) {
    findings.push({
      severity: "fail",
      code: "BOOKING_CHECKOUT_RELATED_COUNT_MISMATCH",
      owner: "Booking checkout",
      targetObject: "booking.guest_bookings",
      message: `Related checkout row counts did not match for booking ${flow.guestBookingId}`,
      expected: JSON.stringify({
        guestCount: flow.guestCount,
        addonSelectionCount: flow.addonSelectionCount,
        promoApplicationCount: flow.promoApplicationCount,
        statusEventCount: flow.statusEventCount,
      }),
      actual: JSON.stringify(actual),
      suggestedAction:
        "Check fixture coverage for booking guest, addon, promo, and lifecycle event relationships.",
    });
  }
}

async function checkSummaryPublicSafety(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const forbiddenKeys = expected.bookingCheckoutChecks?.forbiddenSummaryKeys ?? [];
  if (forbiddenKeys.length === 0) return;

  const result = await client.query<{ guest_booking_id: string; summary: string }>(
    `SELECT guest_booking_id::text,
            concat_ws(
              ' ',
              public_reference,
              lifecycle_status,
              payment_status,
              guest_counts::text,
              room_summary::text,
              amount_summary::text,
              public_policy::text,
              source_freshness::text
            ) AS summary
     FROM booking.direct_booking_summary_read_model`,
  );

  for (const row of result.rows) {
    const matchedKey = forbiddenKeys.find((key) => row.summary.includes(key));
    if (!matchedKey) continue;

    findings.push({
      severity: "fail",
      code: "BOOKING_CHECKOUT_SUMMARY_PRIVATE_KEY_LEAK",
      owner: "Booking checkout",
      targetObject: "booking.direct_booking_summary_read_model",
      message: `Booking summary ${row.guest_booking_id} contains forbidden private key ${matchedKey}`,
      expected: "No guest PII or private checkout input in the summary read-model",
      actual: matchedKey,
      suggestedAction:
        "Keep guest PII in checkout/guest tables and project only public-safe booking summary fields.",
    });
  }
}

async function checkBookingSettings(
  client: pg.Client,
  settings: BookingSettingsCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    booking_hotel_resource_id: string | null;
    source_link_status: string | null;
    source_link_relationship: string | null;
    show_addons_step: boolean;
    group_addons_by_category: boolean;
    special_requests_enabled: boolean;
    arrival_time_enabled: boolean;
    guest_count_enabled: boolean;
    phone_required: boolean;
    adult_age_threshold: number;
    children_enabled: boolean;
    benefits: unknown;
    default_currency: string;
    default_language: string;
    supported_currencies: string[];
    supported_languages: string[];
    booking_filters: unknown;
    custom_filters: unknown;
    filter_rooms: unknown;
    source_freshness: unknown;
    hero_image_url: string | null;
    hero_heading: string | null;
    hero_subtext: string | null;
    primary_color: string;
    font_pairing: string;
    acceptance_mode: string;
  }>(
    `SELECT
       source.source_id AS booking_hotel_resource_id,
       source.status AS source_link_status,
       source.relationship AS source_link_relationship,
       settings.show_addons_step,
       settings.group_addons_by_category,
       settings.special_requests_enabled,
       settings.arrival_time_enabled,
       settings.guest_count_enabled,
       settings.phone_required,
       settings.adult_age_threshold,
       settings.children_enabled,
       settings.benefits,
       settings.default_currency,
       settings.default_language,
       settings.supported_currencies,
       settings.supported_languages,
       settings.booking_filters,
       settings.custom_filters,
       settings.filter_rooms,
       settings.source_freshness,
       settings.hero_image_url,
       settings.hero_heading,
       settings.hero_subtext,
       settings.primary_color,
       settings.font_pairing
       , settings.acceptance_mode
     FROM booking.booking_settings settings
     LEFT JOIN hotel_catalog.property_source_links source
       ON source.property_id = settings.property_id
      AND source.source_system = 'booking'
      AND source.source_table = 'booking_hotels'
      AND source.source_id = $2
      AND source.status = 'active'
      AND source.relationship = 'canonical_input'
     WHERE settings.property_id = $1`,
    [settings.propertyId, settings.bookingHotelResourceId],
  );

  const row = result.rows[0];
  const matches =
    row &&
    row.booking_hotel_resource_id === settings.bookingHotelResourceId &&
    row.source_link_status === "active" &&
    row.source_link_relationship === "canonical_input" &&
    row.show_addons_step === settings.showAddonsStep &&
    row.group_addons_by_category === settings.groupAddonsByCategory &&
    row.special_requests_enabled === settings.specialRequestsEnabled &&
    row.arrival_time_enabled === settings.arrivalTimeEnabled &&
    row.guest_count_enabled === settings.guestCountEnabled &&
    row.phone_required === settings.phoneRequired &&
    row.adult_age_threshold === settings.adultAgeThreshold &&
    row.children_enabled === settings.childrenEnabled &&
    sameJsonValue(row.benefits, settings.benefits) &&
    row.default_currency === settings.defaultCurrency &&
    row.default_language === settings.defaultLanguage &&
    sameJsonValue(row.supported_currencies, settings.supportedCurrencies) &&
    sameJsonValue(row.supported_languages, settings.supportedLanguages) &&
    sameJsonValue(row.booking_filters, settings.bookingFilters) &&
    sameJsonValue(row.custom_filters, settings.customFilters) &&
    sameJsonValue(row.filter_rooms, settings.filterRooms) &&
    sameJsonValue(row.source_freshness, settings.sourceFreshness) &&
    row.hero_image_url === settings.heroImageUrl &&
    row.hero_heading === settings.heroHeading &&
    row.hero_subtext === settings.heroSubtext &&
    row.primary_color === settings.primaryColor &&
    row.font_pairing === settings.fontPairing &&
    row.acceptance_mode === settings.acceptanceMode;

  if (!matches) {
    findings.push({
      severity: "fail",
      code: "BOOKING_SETTINGS_TARGET_MISMATCH",
      owner: "Booking checkout",
      targetObject: "booking.booking_settings",
      message: `Expected booking settings for property ${settings.propertyId} were not found`,
      expected: JSON.stringify(settings),
      actual: row ? JSON.stringify(row) : "row missing",
      suggestedAction:
        "Check booking settings fixture transform and active canonical booking hotel source link.",
    });
  }
}

async function checkBookingCheckoutFixtures(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const checks = expected.bookingCheckoutChecks;
  if (!checks) return;

  for (const flow of checks.flows) {
    await checkBookingFlow(client, flow, findings);
    await checkOwnershipLink(client, flow, findings);
    await checkRelatedCounts(client, flow, findings);
  }
  for (const settings of checks.settings ?? []) {
    await checkBookingSettings(client, settings, findings);
  }

  await checkSummaryPublicSafety(client, expected, findings);
}

export async function checkBookingCheckoutParity({
  client,
  expected,
  findings,
}: ParityHandlerContext): Promise<void> {
  await checkBookingCheckoutFixtures(client, expected, findings);
}
