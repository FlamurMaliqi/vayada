import { createHash } from "node:crypto";

import {
  BOOKING_LAUNCH_DERIVED_BINDING_SOURCE_ENTITY_TYPE,
  createBookingGuestPolicyAbsentSourceRevision,
  createBookingGuestPolicyPublicProjection,
  createBookingGuestPolicySourceRevision,
  parseBookingDesignReadinessResult,
  parseBookingGuestPolicyRevision,
  type BookingDesignReadinessPort,
  type BookingGuestPolicyReadPort,
  type BookingLaunchConfigurationEvidencePort,
  type BookingLaunchOwnerBlocker,
  type BookingLaunchSourceRevision,
} from "@vayada/domain-booking";
import {
  BOOKING_OWNER_SNAPSHOT_VERSION,
  type BookingPublicationOwnerSnapshotPort,
  type BookingPublicationSnapshotContent,
} from "@vayada/domain-distribution/booking-publication-owner-snapshots";
import type { SourceEntityRevision } from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

type BookingPool = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows">>;
  end?(): Promise<void>;
};
type BookingSource = Omit<SourceEntityRevision, "ownerDomain"> & { ownerDomain: "booking" };
type SettingsRow = QueryResultRow & {
  acceptanceMode: string;
  defaultLanguage: string;
  supportedLanguages: string[];
  headerLogoUrl: string | null;
  showContactButton: boolean;
  showReferAGuestButton: boolean;
  showLanguageSelector: boolean;
  showCurrencySelector: boolean;
  referAGuestModuleEnabled: boolean;
  heroSubtext: string | null;
  hasActivePromos: boolean;
  updatedAt: Date | string;
};
type LoadedBooking = {
  sources: BookingSource[];
  pageSource: BookingSource;
  guestSource: BookingSource;
  pageBindings: BookingLaunchSourceRevision[];
  guestBindings: BookingLaunchSourceRevision[];
  blockers: { page: BookingLaunchOwnerBlocker[]; guest: BookingLaunchOwnerBlocker[] };
  content: BookingPublicationSnapshotContent["booking"] | null;
};

export function createBookingBookingPublicationSource(config: {
  connectionString: string;
  design: BookingDesignReadinessPort;
  guestPolicy: Pick<BookingGuestPolicyReadPort, "getCurrentGuestPolicy">;
  pool?: BookingPool;
}): BookingLaunchConfigurationEvidencePort &
  BookingPublicationOwnerSnapshotPort<"booking"> & { close(): Promise<void> } {
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      max: 4,
    });
  return {
    bookingLaunchEvidencePort: "booking",
    owner: "booking",
    async getBookingLaunchEvidence(request) {
      try {
        const loaded = await load(pool, config.design, config.guestPolicy, request);
        if (!loaded) return unavailableEvidence();
        return deepFreeze({
          outcome: "evidence",
          port: "booking",
          ...request,
          sources: loaded.sources,
          entities: [
            {
              groupId: "booking.page_style",
              owningStepId: "booking_design",
              source: loaded.pageSource,
              blockers: loaded.blockers.page,
              ...(loaded.pageBindings.length ? { bindings: bindings(loaded.pageBindings) } : {}),
            },
            {
              groupId: "booking.guest_experience",
              owningStepId: "guest_experience",
              source: loaded.guestSource,
              blockers: loaded.blockers.guest,
              ...(loaded.guestBindings.length ? { bindings: bindings(loaded.guestBindings) } : {}),
            },
          ],
        });
      } catch {
        return unavailableEvidence("system");
      }
    },
    async getSnapshot(request) {
      try {
        const loaded = await load(pool, config.design, config.guestPolicy, {
          organizationId: request.organizationId,
          propertyId: request.propertyId,
        });
        const expected = request.sourceManifest.sources.filter(
          ({ ownerDomain, entityType }) =>
            ownerDomain === "booking" &&
            entityType !== BOOKING_LAUNCH_DERIVED_BINDING_SOURCE_ENTITY_TYPE,
        );
        if (
          !loaded?.content ||
          loaded.blockers.page.length ||
          loaded.blockers.guest.length ||
          sourceKeys(loaded.sources) !== sourceKeys(expected)
        )
          return unavailableSnapshot();
        return deepFreeze({
          outcome: "snapshot",
          contractVersion: BOOKING_OWNER_SNAPSHOT_VERSION,
          owner: "booking",
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          sourceManifestHash: request.sourceManifestHash,
          resolvedSources: loaded.sources,
          content: loaded.content,
        });
      } catch {
        return unavailableSnapshot();
      }
    },
    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

async function load(
  pool: BookingPool,
  designPort: BookingDesignReadinessPort,
  policyPort: Pick<BookingGuestPolicyReadPort, "getCurrentGuestPolicy">,
  scope: { organizationId: string; propertyId: string },
): Promise<LoadedBooking | null> {
  const [settingsResult, rawDesign, rawPolicy] = await Promise.all([
    pool.query<SettingsRow>(SETTINGS_SQL, [scope.organizationId, scope.propertyId]),
    designPort.getBookingDesignReadiness(scope),
    policyPort.getCurrentGuestPolicy(scope),
  ]);
  const settings = settingsResult.rows.length === 1 ? settingsResult.rows[0]! : null;
  if (!settings) return null;
  const design = parseBookingDesignReadinessResult(rawDesign, scope);
  const policy = rawPolicy === null ? null : parseBookingGuestPolicyRevision(rawPolicy);
  if (!design || design.outcome === "provider_failure" || (rawPolicy !== null && !policy))
    return null;

  const settingsSource = source(
    "booking_settings",
    scope.propertyId,
    `sha256:${sha256(JSON.stringify(settings))}`,
  );
  const pageSource = design.outcome === "ready" ? design.designSource : settingsSource;
  const guestSource = policy
    ? createBookingGuestPolicySourceRevision(scope.propertyId, policy.revision)
    : createBookingGuestPolicyAbsentSourceRevision(scope.propertyId);
  const sources = [
    ...new Map(
      [settingsSource, guestSource, ...(design.outcome === "ready" ? [pageSource] : [])].map(
        (item) => [sourceKey(item), item],
      ),
    ).values(),
  ].sort(compareSource);
  const blockers = {
    page: design.outcome === "ready" ? [] : [ownerBlocker(design.blocker.code)],
    guest: policy ? [] : [ownerBlocker("guest_policy_not_configured")],
  };
  if (design.outcome !== "ready" || !policy) {
    return {
      sources,
      pageSource,
      guestSource,
      pageBindings: [],
      guestBindings: [],
      blockers,
      content: null,
    };
  }
  const projection = createBookingGuestPolicyPublicProjection(policy);
  const hero =
    design.snapshot.cover.kind === "safe_media"
      ? (design.snapshot.cover.publicVariants.find(
          ({ variantName }) => variantName === "original_safe",
        )?.publicUrl ?? null)
      : null;
  const supportedLocales = [
    ...new Set([settings.defaultLanguage, ...settings.supportedLanguages]),
  ].sort();
  const content: BookingPublicationSnapshotContent["booking"] = {
    branding: {
      logoUrl: settings.headerLogoUrl,
      showContactButton: settings.showContactButton,
      showReferAGuestButton: settings.referAGuestModuleEnabled && settings.showReferAGuestButton,
      showLanguageSelector: settings.showLanguageSelector,
      showCurrencySelector: settings.showCurrencySelector,
      heroImage: hero,
      heroHeading: design.snapshot.profile.displayName,
      heroSubtext: settings.heroSubtext ?? design.snapshot.profile.shortDescription,
      primaryColor: design.snapshot.appearance.primaryColor,
      fontPairing: design.snapshot.appearance.fontPairing,
    },
    policies: {
      checkInFrom: projection.policy.checkInTime,
      checkOutUntil: projection.policy.checkOutTime,
      ...(projection.policy.checkInUntil ? { checkInUntil: projection.policy.checkInUntil } : {}),
      ...(projection.policy.checkOutFrom ? { checkOutFrom: projection.policy.checkOutFrom } : {}),
      cancellationSummary: null,
      termsUrl: null,
    },
    capabilities: {
      instantBook: settings.acceptanceMode === "instant",
      promoCodes: settings.hasActivePromos,
      referralCodes: settings.referAGuestModuleEnabled,
    },
    supportedQuoteParameters: {
      minRooms: 1,
      maxRooms: 20,
      minAdults: 1,
      maxAdults: 20,
      childrenSupported: projection.policy.childrenEnabled,
      adultAgeThreshold: projection.policy.adultAgeThreshold ?? 18,
      supportedCurrencies: [projection.policy.pricingCurrency],
      supportedLocales,
    },
    freshness: {
      status: "fresh",
      lastUpdatedAt: latestIso(settings.updatedAt, policy.acceptedAt),
    },
  };
  return {
    sources,
    pageSource,
    guestSource,
    pageBindings: design.snapshot.sourceBindings.filter(validBindingSource),
    guestBindings: policy.bundle.sourceBindings.filter(validBindingSource),
    blockers,
    content,
  };
}

const SETTINGS_SQL = `
SELECT settings.acceptance_mode AS "acceptanceMode",
       settings.default_language AS "defaultLanguage",
       settings.supported_languages AS "supportedLanguages",
       header_logo.public_cdn_url AS "headerLogoUrl",
       settings.show_contact_button AS "showContactButton",
       settings.show_refer_a_guest_button AS "showReferAGuestButton",
       settings.show_language_selector AS "showLanguageSelector",
       settings.show_currency_selector AS "showCurrencySelector",
       EXISTS (
         SELECT 1
         FROM identity.product_entitlements entitlement
         WHERE entitlement.organization_id = $1::uuid
           AND entitlement.product = 'pms'
           AND entitlement.entitlement_key = 'module:affiliates'
           AND entitlement.status = 'active'
           AND entitlement.resource_product = 'pms'
           AND entitlement.resource_type = 'pms_property'
           AND entitlement.resource_id = settings.property_id::text
           AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
           AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
       ) AS "referAGuestModuleEnabled",
       NULLIF(BTRIM(settings.hero_subtext), '') AS "heroSubtext",
       settings.updated_at AS "updatedAt",
       EXISTS (SELECT 1 FROM booking.promo_definitions promo
         WHERE promo.property_id = settings.property_id AND promo.status = 'active'
           AND promo.is_active AND (promo.valid_from IS NULL OR promo.valid_from <= current_date)
           AND (promo.valid_until IS NULL OR promo.valid_until >= current_date)) AS "hasActivePromos"
FROM booking.booking_settings settings
LEFT JOIN LATERAL (
  SELECT variant.public_cdn_url
  FROM platform.media_objects media
  JOIN platform.media_variants variant
    ON variant.media_object_id = media.id
   AND variant.visibility = 'public'
   AND variant.public_cdn_url LIKE 'https://%'
  WHERE media.id = settings.header_logo_media_object_id
    AND media.owner_organization_id = $1::uuid
    AND media.purpose = 'booking.header_logo'
    AND media.visibility = 'public'
    AND media.public_approved = TRUE
    AND media.lifecycle_status = 'active'
    AND media.resource_product = 'booking'
    AND media.resource_type = 'booking_hotel'
    AND (
      media.resource_id = settings.property_id::text
      OR EXISTS (
        SELECT 1
        FROM hotel_catalog.property_source_links source
        WHERE source.property_id = settings.property_id
          AND source.source_system = 'booking'
          AND source.source_table = 'booking_hotels'
          AND source.source_id = media.resource_id
          AND source.relationship = 'canonical_input'
          AND source.status = 'active'
      )
    )
  ORDER BY (variant.variant_name = 'original_safe') DESC, variant.created_at, variant.id
  LIMIT 1
) header_logo ON TRUE
JOIN identity.organization_resource_links resource
  ON resource.organization_id = $1::uuid AND resource.product = 'booking'
 AND resource.resource_type = 'booking_hotel' AND resource.resource_id = settings.property_id::text
 AND resource.relationship IN ('owner', 'operator') AND resource.status = 'active'
WHERE settings.property_id = $2::uuid`;

const bindings = (sources: readonly BookingLaunchSourceRevision[]) =>
  sources.map((expectedSource) => ({
    expectedSource,
    mismatchBlocker: ownerBlocker("booking_publication_source_stale"),
  }));
const source = (entityType: string, entityId: string, revision: string): BookingSource => ({
  ownerDomain: "booking",
  entityType,
  entityId,
  revision,
});
const ownerBlocker = (code: string): BookingLaunchOwnerBlocker => ({
  code,
  scope: "launch_configuration",
  kind: "user_fixable",
});
const unavailableEvidence = (errorSource: "provider" | "system" = "provider") => ({
  outcome: "unavailable" as const,
  port: "booking" as const,
  errorSource,
});
const unavailableSnapshot = () => ({ outcome: "unavailable" as const, owner: "booking" as const });
const sourceKeys = (sources: readonly SourceEntityRevision[]) =>
  sources.map(sourceKey).sort().join("\0");
const compareSource = (left: SourceEntityRevision, right: SourceEntityRevision) =>
  sourceKey(left).localeCompare(sourceKey(right));
const sourceKey = ({ ownerDomain, entityType, entityId, revision }: SourceEntityRevision) =>
  JSON.stringify([ownerDomain, entityType, entityId, revision]);
const validBindingSource = (source: SourceEntityRevision): source is BookingLaunchSourceRevision =>
  source.ownerDomain === "hotel_catalog" ||
  source.ownerDomain === "pms" ||
  source.ownerDomain === "finance";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const latestIso = (...values: (Date | string)[]) =>
  new Date(Math.max(...values.map((value) => new Date(value).getTime()))).toISOString();
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
