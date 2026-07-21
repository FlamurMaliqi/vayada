import pg, { type QueryResult, type QueryResultRow } from "pg";

import type {
  SharedHotelSetupEntryProduct,
  SharedHotelSetupStatusRepository,
  SharedPropertyProfile,
  SharedPropertyProfileInput,
  SharedPropertyProfileLocation,
  SharedPropertyProfileMedia,
  SharedProductActivation,
  SharedPropertyProfileMissingField,
  SharedSetupProperty,
} from "../routes/sharedHotelSetupStatus.js";

type SharedHotelSetupStatusPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type SharedHotelSetupRow = {
  propertyId: string;
  publicId: string;
  displayName: string | null;
  profileStatus: string | null;
  profileSource: string | null;
  location: unknown;
  descriptions: unknown;
  media: unknown;
  publicContacts: unknown;
  bookingSelected: boolean;
  bookingSelectionUpdatedAt: unknown;
  hasBookingSettings: boolean;
  bookingSettingsUpdatedAt: unknown;
  bookingEntitlementActive: boolean;
  bookingEntitlementSuspended: boolean;
  bookingEntitlementUpdatedAt: unknown;
  bookabilityStatus: string | null;
  bookabilityFreshnessStatus: string | null;
  bookabilityUpdatedAt: unknown;
  paymentsEnabled: boolean | null;
  paymentSettingsUpdatedAt: unknown;
  pmsSelected: boolean;
  pmsSelectionUpdatedAt: unknown;
  pmsEntitlementActive: boolean;
  pmsEntitlementSuspended: boolean;
  pmsEntitlementUpdatedAt: unknown;
  pmsRoomTypeCount: number | string;
  pmsRoomUpdatedAt: unknown;
  pmsRoomCount: number | string;
  pmsRatePlanCount: number | string;
  pmsRateUpdatedAt: unknown;
  marketplaceSelected: boolean;
  marketplaceSelectionUpdatedAt: unknown;
  marketplaceEntitlementActive: boolean;
  marketplaceEntitlementSuspended: boolean;
  marketplaceEntitlementUpdatedAt: unknown;
  marketplaceProfileStatus: string | null;
  marketplaceProfileComplete: boolean | null;
  marketplaceProfileUpdatedAt: unknown;
  marketplaceOfferCount: number | string;
  marketplaceVerifiedOfferCount: number | string;
  marketplacePublicOfferCount: number | string;
  marketplaceOfferUpdatedAt: unknown;
  marketplaceDeliverableCount: number | string;
  marketplaceDeliverableUpdatedAt: unknown;
  marketplaceCompensationCount: number | string;
  marketplaceCompensationUpdatedAt: unknown;
  marketplaceRequirementCount: number | string;
  marketplaceRequirementUpdatedAt: unknown;
};

type AccountProductSelectionRow = {
  product: SharedHotelSetupEntryProduct;
  updatedAt: unknown;
};

type SharedPropertyProfileRow = {
  propertyId: string;
  publicId: string;
  displayName: string | null;
  propertyType: string | null;
  profileStatus: string | null;
  profileSource: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  streetAddress: string | null;
  postalCode: string | null;
  rawMarketplaceLocation: string | null;
  timezone: string | null;
  latitude: unknown;
  longitude: unknown;
  addressPublic: boolean | null;
  mapDisplayMode: string | null;
  shortDescription: string | null;
  longDescription: string | null;
  website: string | null;
  contactEmail: string | null;
  phone: string | null;
  media: unknown;
  updatedAt: unknown;
};

type PropertyProfileWriteRow = {
  propertyId: string;
};

type SharedPropertyProfileWritePayload = {
  display_name: string;
  property_type: SharedPropertyProfileInput["propertyType"];
  country_code: string | null;
  region: string | null;
  city: string | null;
  street_address: string | null;
  postal_code: string | null;
  raw_marketplace_location: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  address_public: boolean;
  map_display_mode: SharedPropertyProfileLocation["mapDisplayMode"];
  short_description: string | null;
  long_description: string | null;
  website: string | null;
  contact_email: string | null;
  phone: string | null;
  media: Array<{
    media_type: SharedPropertyProfileMedia["mediaType"];
    url: string;
    alt_text: string | null;
    sort_order: number;
  }>;
};

const PRODUCT_ORDER: readonly SharedHotelSetupEntryProduct[] = ["booking", "pms", "marketplace"];

export function createPgSharedHotelSetupStatusRepository(config: {
  connectionString: string;
  max?: number;
  pool?: SharedHotelSetupStatusPool;
}): SharedHotelSetupStatusRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Shared hotel setup status repository connectionString must not be empty");
  }

  const ownsPool = config.pool === undefined;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async getHotelSetupStatus({ organizationId, propertyIds }) {
      const hotelGroup = await pool.query<{ displayName: string; websiteUrl: string | null }>(
        `SELECT name AS "displayName", website_url AS "websiteUrl"
         FROM identity.organizations
         WHERE id = $1::uuid
           AND kind = 'hotel_group'
           AND status = 'active'
         LIMIT 1`,
        [organizationId],
      );
      const accountProducts = await pool.query<AccountProductSelectionRow>(
        organizationProductSelectionsSql(),
        [organizationId, PRODUCT_ORDER],
      );
      const hotelGroupSelectedProducts = PRODUCT_ORDER.filter((product) =>
        accountProducts.rows.some((row) => row.product === product),
      );

      if (propertyIds.length === 0) {
        return {
          hotelGroupDisplayName: hotelGroup.rows[0]?.displayName ?? null,
          hotelGroupWebsiteUrl: hotelGroup.rows[0]?.websiteUrl ?? null,
          hotelGroupSelectedProducts,
          properties: [],
        };
      }

      const result = await pool.query<SharedHotelSetupRow>(sharedHotelSetupStatusSql(), [
        organizationId,
        propertyIds,
      ]);

      return {
        hotelGroupDisplayName: hotelGroup.rows[0]?.displayName ?? null,
        hotelGroupWebsiteUrl: hotelGroup.rows[0]?.websiteUrl ?? null,
        hotelGroupSelectedProducts,
        properties: result.rows.map(toSharedSetupProperty),
      };
    },
    async getPropertyProfile({ organizationId, propertyId }) {
      return loadPropertyProfile(pool, organizationId, propertyId);
    },
    async createPropertyProfile({ organizationId, profile }) {
      const propertyId = await writePropertyProfile(pool, {
        organizationId,
        profile,
        mode: "create",
      });
      if (!propertyId) {
        throw new Error("Created shared property profile did not return a property id");
      }
      const created = await loadPropertyProfile(pool, organizationId, propertyId);
      if (!created) {
        throw new Error("Created shared property profile could not be loaded");
      }
      return created;
    },
    async updatePropertyProfile({ organizationId, propertyId, expectedPropertyType, profile }) {
      const updatedPropertyId = await writePropertyProfile(pool, {
        organizationId,
        propertyId,
        expectedPropertyType,
        profile,
        mode: "update",
      });
      if (!updatedPropertyId) return null;
      return loadPropertyProfile(pool, organizationId, updatedPropertyId);
    },
    async setOrganizationProductSelections({ organizationId, selectedProducts }) {
      const result = await pool.query<AccountProductSelectionRow>(
        organizationProductSelectionsWriteSql(),
        [organizationId, selectedProducts, PRODUCT_ORDER],
      );
      const selected = new Set(result.rows.map((row) => row.product));

      return {
        organizationId,
        selectedProducts: PRODUCT_ORDER.filter((product) => selected.has(product)),
        updatedAt: latest(...result.rows.map((row) => row.updatedAt)) ?? new Date().toISOString(),
      };
    },
    async close() {
      if (ownsPool) {
        await pool.end();
      }
    },
  };
}

async function loadPropertyProfile(
  pool: SharedHotelSetupStatusPool,
  organizationId: string,
  propertyId: string,
): Promise<SharedPropertyProfile | null> {
  const result = await pool.query<SharedPropertyProfileRow>(propertyProfileSql(), [
    organizationId,
    propertyId,
  ]);
  const row = result.rows[0];
  return row ? toSharedPropertyProfile(row) : null;
}

async function writePropertyProfile(
  pool: SharedHotelSetupStatusPool,
  input:
    | { mode: "create"; organizationId: string; profile: SharedPropertyProfileInput }
    | {
        mode: "update";
        organizationId: string;
        propertyId: string;
        expectedPropertyType: string | null;
        profile: SharedPropertyProfileInput;
      },
): Promise<string | null> {
  const missingFields = profileInputMissingFields(input.profile);
  const profileStatus = missingFields.length === 0 ? "complete" : "incomplete";
  const payload = propertyProfileWritePayload(input.profile);
  const result =
    input.mode === "create"
      ? await pool.query<PropertyProfileWriteRow>(createPropertyProfileSql(), [
          input.organizationId,
          payload,
          profileStatus,
          missingFields,
        ])
      : await pool.query<PropertyProfileWriteRow>(updatePropertyProfileSql(), [
          input.organizationId,
          input.propertyId,
          payload,
          profileStatus,
          missingFields,
          input.expectedPropertyType,
        ]);

  return result.rows[0]?.propertyId ?? null;
}

function toSharedPropertyProfile(row: SharedPropertyProfileRow): SharedPropertyProfile {
  const media = mediaItems(row.media);
  const profile: SharedPropertyProfileInput = {
    displayName: nonEmpty(row.displayName) ?? "",
    propertyType: nonEmpty(row.propertyType),
    location: {
      countryCode: nonEmpty(row.countryCode),
      region: nonEmpty(row.region),
      city: nonEmpty(row.city),
      streetAddress: nonEmpty(row.streetAddress),
      postalCode: nonEmpty(row.postalCode),
      rawMarketplaceLocation: nonEmpty(row.rawMarketplaceLocation),
      timezone: nonEmpty(row.timezone),
      latitude: numberOrNull(row.latitude),
      longitude: numberOrNull(row.longitude),
      addressPublic: row.addressPublic ?? true,
      mapDisplayMode: mapDisplayMode(row.mapDisplayMode),
    },
    website: nonEmpty(row.website),
    contactEmail: nonEmpty(row.contactEmail),
    phone: nonEmpty(row.phone),
    shortDescription: nonEmpty(row.shortDescription),
    longDescription: nonEmpty(row.longDescription),
    media,
  };
  const computedMissingFields = profileInputMissingFields(profile);
  const status = sharedProfileStatus(row.profileStatus, computedMissingFields);
  const missingFields = status === "complete" ? [] : computedMissingFields;
  const source = sharedProfileSource(row.profileSource);

  return {
    propertyId: row.propertyId,
    publicId: row.publicId,
    ...profile,
    sharedProfile: {
      status,
      source,
      completionPercent: completionPercent(missingFields),
      missingFields,
    },
    updatedAt: toIsoString(row.updatedAt) ?? new Date().toISOString(),
  };
}

function toSharedSetupProperty(row: SharedHotelSetupRow): SharedSetupProperty {
  const computedMissingFields = sharedProfileMissingFields(row);
  const sharedStatus = sharedProfileStatus(row.profileStatus, computedMissingFields);
  const missingFields = sharedStatus === "complete" ? [] : computedMissingFields;
  const source = sharedProfileSource(row.profileSource);

  return {
    propertyId: row.propertyId,
    publicId: row.publicId,
    displayName: nonEmpty(row.displayName),
    locationSummary: locationSummary(row.location),
    sharedProfile: {
      status: sharedStatus,
      source,
      completionPercent: completionPercent(missingFields),
      missingFields,
    },
    products: {
      booking: bookingActivation(row),
      pms: pmsActivation(row),
      marketplace: marketplaceActivation(row),
    },
  };
}

function sharedProfileStatus(
  value: string | null,
  missingFields: SharedPropertyProfileMissingField[],
): SharedSetupProperty["sharedProfile"]["status"] {
  if (value === "disabled" || value === "private") return value;
  return missingFields.length === 0 ? "complete" : "incomplete";
}

function sharedProfileSource(value: string | null): SharedSetupProperty["sharedProfile"]["source"] {
  return value === "legacy_prefill" ? "legacy_prefill" : "canonical";
}

function sharedProfileMissingFields(row: SharedHotelSetupRow): SharedPropertyProfileMissingField[] {
  const missing: SharedPropertyProfileMissingField[] = [];
  const needsGuestProfile = row.bookingSelected || row.marketplaceSelected;
  if (!nonEmpty(row.displayName)) missing.push("displayName");
  if (!hasLocation(row.location)) missing.push("location");
  if (needsGuestProfile && !hasContact(row.publicContacts, ["website"])) missing.push("website");
  if (needsGuestProfile && !hasContact(row.publicContacts, ["phone", "whatsapp"])) {
    missing.push("phone");
  }
  if (needsGuestProfile && !hasDescription(row.descriptions)) missing.push("description");
  if (needsGuestProfile && !hasMedia(row.media)) missing.push("media");
  return missing;
}

function profileInputMissingFields(
  profile: SharedPropertyProfileInput,
): SharedPropertyProfileMissingField[] {
  const missing: SharedPropertyProfileMissingField[] = [];
  if (!nonEmpty(profile.displayName)) missing.push("displayName");
  if (!hasProfileLocation(profile.location)) missing.push("location");
  if (!nonEmpty(profile.website)) missing.push("website");
  if (!nonEmpty(profile.phone)) missing.push("phone");
  if (!nonEmpty(profile.shortDescription) && !nonEmpty(profile.longDescription)) {
    missing.push("description");
  }
  if (profile.media.length === 0) missing.push("media");
  return missing;
}

function hasProfileLocation(location: SharedPropertyProfileLocation): boolean {
  return [location.rawMarketplaceLocation, location.city, location.countryCode].some(
    (value) => nonEmpty(value) !== null,
  );
}

function completionPercent(missingFields: SharedPropertyProfileMissingField[]): number {
  return missingFields.length === 0 ? 100 : Math.round(((6 - missingFields.length) / 6) * 100);
}

function propertyProfileWritePayload(
  profile: SharedPropertyProfileInput,
): SharedPropertyProfileWritePayload {
  return {
    display_name: profile.displayName,
    property_type: profile.propertyType,
    country_code: profile.location.countryCode,
    region: profile.location.region,
    city: profile.location.city,
    street_address: profile.location.streetAddress,
    postal_code: profile.location.postalCode,
    raw_marketplace_location: profile.location.rawMarketplaceLocation,
    timezone: profile.location.timezone,
    latitude: profile.location.latitude,
    longitude: profile.location.longitude,
    address_public: profile.location.addressPublic,
    map_display_mode: profile.location.mapDisplayMode,
    short_description: profile.shortDescription,
    long_description: profile.longDescription,
    website: profile.website,
    contact_email: profile.contactEmail,
    phone: profile.phone,
    media: profile.media.map((item) => ({
      media_type: item.mediaType,
      url: item.url,
      alt_text: item.altText,
      sort_order: item.sortOrder,
    })),
  };
}

function bookingActivation(row: SharedHotelSetupRow): SharedProductActivation<"booking"> {
  if (!row.bookingSelected) return notSelected("booking");
  if (row.bookingEntitlementSuspended) {
    return productActivation(
      "booking",
      "suspended",
      [],
      ["booking_suspended"],
      row.bookingEntitlementUpdatedAt,
    );
  }
  const missingSteps: string[] = [];
  if (!row.bookingEntitlementActive) missingSteps.push("productEntitlement");
  if (!row.hasBookingSettings) missingSteps.push("bookingSettings");
  if (row.bookabilityStatus !== "public") missingSteps.push("publicBookability");
  if (row.bookabilityStatus === "public" && row.bookabilityFreshnessStatus !== "fresh") {
    missingSteps.push("bookabilityFreshness");
  }
  if (row.paymentsEnabled !== true) missingSteps.push("paymentReadiness");

  if (row.bookabilityStatus === "unavailable") {
    return productActivation(
      "booking",
      "unavailable",
      missingSteps,
      ["booking_unavailable"],
      latest(
        row.bookingSelectionUpdatedAt,
        row.bookingSettingsUpdatedAt,
        row.bookabilityUpdatedAt,
        row.paymentSettingsUpdatedAt,
        row.bookingEntitlementUpdatedAt,
      ),
    );
  }

  return missingSteps.length === 0
    ? productActivation(
        "booking",
        "active",
        [],
        [],
        latest(
          row.bookingSelectionUpdatedAt,
          row.bookingSettingsUpdatedAt,
          row.bookabilityUpdatedAt,
          row.paymentSettingsUpdatedAt,
          row.bookingEntitlementUpdatedAt,
        ),
      )
    : productActivation(
        "booking",
        "selected_incomplete",
        missingSteps,
        ["booking_activation_incomplete"],
        latest(
          row.bookingSelectionUpdatedAt,
          row.bookingSettingsUpdatedAt,
          row.bookabilityUpdatedAt,
          row.paymentSettingsUpdatedAt,
          row.bookingEntitlementUpdatedAt,
        ),
      );
}

function pmsActivation(row: SharedHotelSetupRow): SharedProductActivation<"pms"> {
  const roomTypes = toCount(row.pmsRoomTypeCount);
  const rooms = toCount(row.pmsRoomCount);
  const ratePlans = toCount(row.pmsRatePlanCount);
  if (!row.pmsSelected) return notSelected("pms");
  if (row.pmsEntitlementSuspended) {
    return productActivation(
      "pms",
      "suspended",
      [],
      ["pms_suspended"],
      row.pmsEntitlementUpdatedAt,
    );
  }

  const missingSteps: string[] = [];
  if (!row.pmsEntitlementActive) missingSteps.push("productEntitlement");
  if (roomTypes === 0) missingSteps.push("roomTypes");
  if (rooms === 0) missingSteps.push("rooms");
  if (ratePlans === 0) missingSteps.push("ratePlans");

  return missingSteps.length === 0
    ? productActivation(
        "pms",
        "active",
        [],
        [],
        latest(
          row.pmsSelectionUpdatedAt,
          row.pmsRoomUpdatedAt,
          row.pmsRateUpdatedAt,
          row.pmsEntitlementUpdatedAt,
        ),
      )
    : productActivation(
        "pms",
        "selected_incomplete",
        missingSteps,
        ["pms_activation_incomplete"],
        latest(
          row.pmsSelectionUpdatedAt,
          row.pmsRoomUpdatedAt,
          row.pmsRateUpdatedAt,
          row.pmsEntitlementUpdatedAt,
        ),
      );
}

function marketplaceActivation(row: SharedHotelSetupRow): SharedProductActivation<"marketplace"> {
  if (!row.marketplaceSelected) return notSelected("marketplace");
  if (row.marketplaceEntitlementSuspended) {
    return productActivation(
      "marketplace",
      "suspended",
      [],
      ["marketplace_suspended"],
      row.marketplaceEntitlementUpdatedAt,
    );
  }
  if (row.marketplaceProfileStatus === "suspended") {
    return productActivation(
      "marketplace",
      "suspended",
      [],
      ["marketplace_suspended"],
      row.marketplaceProfileUpdatedAt,
    );
  }
  if (row.marketplaceProfileStatus === "rejected" || row.marketplaceProfileStatus === "archived") {
    return productActivation(
      "marketplace",
      "unavailable",
      [],
      ["marketplace_unavailable"],
      row.marketplaceProfileUpdatedAt,
    );
  }

  const missingSteps: string[] = [];
  const offerCount = toCount(row.marketplaceOfferCount);
  const verifiedOfferCount = toCount(row.marketplaceVerifiedOfferCount);
  const publicOfferCount = toCount(row.marketplacePublicOfferCount);
  const deliverableCount = toCount(row.marketplaceDeliverableCount);
  const compensationCount = toCount(row.marketplaceCompensationCount);
  if (!row.marketplaceEntitlementActive) missingSteps.push("productEntitlement");
  if (row.marketplaceProfileComplete !== true) missingSteps.push("creatorPitch");
  if (offerCount === 0) missingSteps.push("marketplaceOffer");
  if (verifiedOfferCount > 0 && publicOfferCount === 0) missingSteps.push("marketplaceOffer");
  if (deliverableCount === 0) missingSteps.push("offerDeliverables");
  if (compensationCount === 0) missingSteps.push("compensationOptions");
  if (toCount(row.marketplaceRequirementCount) === 0) missingSteps.push("creatorRequirements");

  return missingSteps.length === 0 &&
    row.marketplaceProfileStatus === "verified" &&
    publicOfferCount > 0
    ? productActivation("marketplace", "active", [], [], marketplaceUpdatedAt(row))
    : productActivation(
        "marketplace",
        "selected_incomplete",
        unique(missingSteps),
        ["marketplace_activation_incomplete"],
        marketplaceUpdatedAt(row),
      );
}

function notSelected<Product extends SharedHotelSetupEntryProduct>(
  product: Product,
): SharedProductActivation<Product> {
  return { product, status: "not_selected", missingSteps: [], statusReasons: [], updatedAt: null };
}

function productActivation<Product extends SharedHotelSetupEntryProduct>(
  product: Product,
  status: SharedProductActivation<Product>["status"],
  missingSteps: string[],
  statusReasons: string[],
  updatedAt: unknown,
): SharedProductActivation<Product> {
  return { product, status, missingSteps, statusReasons, updatedAt: toIsoString(updatedAt) };
}

function marketplaceUpdatedAt(row: SharedHotelSetupRow): string | null {
  return latest(
    row.marketplaceSelectionUpdatedAt,
    row.marketplaceEntitlementUpdatedAt,
    row.marketplaceProfileUpdatedAt,
    row.marketplaceOfferUpdatedAt,
    row.marketplaceDeliverableUpdatedAt,
    row.marketplaceCompensationUpdatedAt,
    row.marketplaceRequirementUpdatedAt,
  );
}

function propertyProfileSql(): string {
  return `
    SELECT
      property.id::text AS "propertyId",
      property.public_id AS "publicId",
      COALESCE(
        NULLIF(property.display_name, ''),
        NULLIF(public_profile.display_name, ''),
        marketplace_prefill.display_name
      ) AS "displayName",
      NULLIF(property.property_type, '') AS "propertyType",
      property.profile_status AS "profileStatus",
      CASE
        WHEN (
            NULLIF(property.display_name, '') IS NULL
            AND COALESCE(NULLIF(public_profile.display_name, ''), marketplace_prefill.display_name) IS NOT NULL
          )
          OR (catalog_location.country_code IS NULL AND legacy_location.country_code IS NOT NULL)
          OR (catalog_location.region IS NULL AND legacy_location.region IS NOT NULL)
          OR (catalog_location.city IS NULL AND legacy_location.city IS NOT NULL)
          OR (catalog_location.street_address IS NULL AND legacy_location.street_address IS NOT NULL)
          OR (catalog_location.postal_code IS NULL AND legacy_location.postal_code IS NOT NULL)
          OR (
            catalog_location.raw_marketplace_location IS NULL
            AND legacy_location.raw_marketplace_location IS NOT NULL
          )
          OR (catalog_location.timezone IS NULL AND legacy_location.timezone IS NOT NULL)
          OR (catalog_location.latitude IS NULL AND legacy_location.latitude IS NOT NULL)
          OR (catalog_location.longitude IS NULL AND legacy_location.longitude IS NOT NULL)
          OR (catalog_location.map_display_mode IS NULL AND legacy_location.map_display_mode IS NOT NULL)
          OR (NULLIF(profile.short_description, '') IS NULL AND legacy_description.short_description IS NOT NULL)
          OR (NULLIF(profile.long_description, '') IS NULL AND legacy_description.long_description IS NOT NULL)
          OR (contact.website IS NULL AND legacy_contact.website IS NOT NULL)
          OR (contact.email IS NULL AND legacy_contact.email IS NOT NULL)
          OR (contact.phone IS NULL AND legacy_contact.phone IS NOT NULL)
          OR (COALESCE(jsonb_array_length(media.items), 0) = 0 AND legacy_media.has_media)
          THEN 'legacy_prefill'
        ELSE 'canonical'
      END AS "profileSource",
      COALESCE(catalog_location.country_code, legacy_location.country_code) AS "countryCode",
      COALESCE(catalog_location.region, legacy_location.region) AS region,
      COALESCE(catalog_location.city, legacy_location.city) AS city,
      COALESCE(catalog_location.street_address, legacy_location.street_address) AS "streetAddress",
      COALESCE(catalog_location.postal_code, legacy_location.postal_code) AS "postalCode",
      COALESCE(catalog_location.raw_marketplace_location, legacy_location.raw_marketplace_location) AS "rawMarketplaceLocation",
      COALESCE(catalog_location.timezone, legacy_location.timezone) AS timezone,
      COALESCE(catalog_location.latitude, legacy_location.latitude) AS latitude,
      COALESCE(catalog_location.longitude, legacy_location.longitude) AS longitude,
      COALESCE(catalog_location.address_public, TRUE) AS "addressPublic",
      COALESCE(catalog_location.map_display_mode, legacy_location.map_display_mode, 'hidden') AS "mapDisplayMode",
      COALESCE(NULLIF(profile.short_description, ''), legacy_description.short_description) AS "shortDescription",
      COALESCE(NULLIF(profile.long_description, ''), legacy_description.long_description) AS "longDescription",
      COALESCE(contact.website, legacy_contact.website) AS website,
      COALESCE(contact.email, legacy_contact.email) AS "contactEmail",
      COALESCE(contact.phone, legacy_contact.phone) AS phone,
      COALESCE(media.items, legacy_media.items, '[]'::jsonb) AS media,
      updated_at.value AS "updatedAt"
    FROM hotel_catalog.properties property
    JOIN identity.organization_resource_links link
      ON link.organization_id = $1::uuid
     AND link.product = 'hotel_catalog'
     AND link.resource_type = 'property'
     AND link.resource_id = property.id::text
     AND link.relationship IN ('owner', 'operator')
     AND link.status = 'active'
    LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile
      ON public_profile.property_id = property.id
    LEFT JOIN LATERAL (
      SELECT
        NULLIF(location.country_code::text, '') AS country_code,
        NULLIF(location.region, '') AS region,
        NULLIF(location.city, '') AS city,
        NULLIF(location.street_address, '') AS street_address,
        NULLIF(location.postal_code, '') AS postal_code,
        NULLIF(location.raw_marketplace_location, '') AS raw_marketplace_location,
        NULLIF(location.timezone, '') AS timezone,
        location.latitude,
        location.longitude,
        location.address_public,
        location.map_display_mode,
        location.source_confidence,
        (
          NULLIF(location.country_code::text, '') IS NOT NULL
          OR NULLIF(location.city, '') IS NOT NULL
          OR NULLIF(location.raw_marketplace_location, '') IS NOT NULL
        ) AS has_location,
        location.updated_at
      FROM hotel_catalog.property_locations location
      WHERE location.property_id = property.id
      LIMIT 1
    ) catalog_location ON TRUE
    LEFT JOIN hotel_catalog.property_profiles profile
      ON profile.property_id = property.id
     AND profile.locale = property.default_locale
    LEFT JOIN LATERAL (
      SELECT
        (
          NULLIF(profile.short_description, '') IS NOT NULL
          OR NULLIF(profile.long_description, '') IS NOT NULL
        ) AS has_description
    ) catalog_profile ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        NULLIF(listing.title, '') AS display_name,
        NULLIF(listing.raw_location_text, '') AS raw_location_text,
        NULLIF(listing.offer_summary, '') AS offer_summary,
        NULLIF(profile.host_summary, '') AS host_summary,
        listing.image_urls,
        latest.value AS updated_at
      FROM marketplace.marketplace_hotel_profiles profile
      LEFT JOIN LATERAL (
        SELECT title, raw_location_text, offer_summary, image_urls, updated_at
        FROM marketplace.marketplace_offers
        WHERE property_id = property.id
          AND organization_id = $1::uuid
          AND offer_status <> 'archived'
        ORDER BY
          CASE offer_status WHEN 'verified' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
          updated_at DESC,
          id
        LIMIT 1
      ) listing ON TRUE
      LEFT JOIN LATERAL (
        SELECT max(value) AS value
        FROM (VALUES (profile.updated_at), (listing.updated_at)) AS timestamps(value)
      ) latest ON TRUE
      WHERE profile.property_id = property.id
        AND profile.organization_id = $1::uuid
      LIMIT 1
    ) marketplace_prefill ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        CASE
          WHEN length(COALESCE(
            public_profile.location ->> 'countryCode',
            public_profile.location ->> 'country'
          )) = 2
          THEN upper(COALESCE(
            public_profile.location ->> 'countryCode',
            public_profile.location ->> 'country'
          ))
          ELSE NULL
        END AS country_code,
        NULLIF(public_profile.location ->> 'region', '') AS region,
        NULLIF(public_profile.location ->> 'city', '') AS city,
        NULLIF(public_profile.location ->> 'streetAddress', '') AS street_address,
        NULLIF(public_profile.location ->> 'postalCode', '') AS postal_code,
        COALESCE(
          NULLIF(public_profile.location ->> 'rawMarketplaceLocation', ''),
          NULLIF(public_profile.location ->> 'display', ''),
          CASE
            WHEN length(NULLIF(public_profile.location ->> 'country', '')) > 2
              THEN NULLIF(public_profile.location ->> 'country', '')
            ELSE NULL
          END,
          marketplace_prefill.raw_location_text
        ) AS raw_marketplace_location,
        NULLIF(public_profile.location ->> 'timezone', '') AS timezone,
        CASE
          WHEN COALESCE(public_profile.location ->> 'latitude', public_profile.location #>> '{geo,latitude}')
            ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN COALESCE(public_profile.location ->> 'latitude', public_profile.location #>> '{geo,latitude}')::numeric
          ELSE NULL
        END AS latitude,
        CASE
          WHEN COALESCE(public_profile.location ->> 'longitude', public_profile.location #>> '{geo,longitude}')
            ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN COALESCE(public_profile.location ->> 'longitude', public_profile.location #>> '{geo,longitude}')::numeric
          ELSE NULL
        END AS longitude,
        CASE
          WHEN public_profile.location ->> 'mapDisplayMode' IN ('hidden', 'approximate', 'exact')
            THEN public_profile.location ->> 'mapDisplayMode'
          WHEN public_profile.location ? 'geo' THEN 'approximate'
          ELSE 'hidden'
        END AS map_display_mode,
        (
          NULLIF(public_profile.location ->> 'city', '') IS NOT NULL
          OR NULLIF(public_profile.location ->> 'countryCode', '') IS NOT NULL
          OR NULLIF(public_profile.location ->> 'country', '') IS NOT NULL
          OR NULLIF(public_profile.location ->> 'rawMarketplaceLocation', '') IS NOT NULL
          OR NULLIF(public_profile.location ->> 'display', '') IS NOT NULL
          OR marketplace_prefill.raw_location_text IS NOT NULL
        ) AS has_location
      WHERE catalog_location.source_confidence IS DISTINCT FROM 'verified'
    ) legacy_location ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(
          NULLIF(public_profile.descriptions ->> 'shortDescription', ''),
          NULLIF(public_profile.descriptions ->> 'short_description', ''),
          NULLIF(public_profile.descriptions ->> 'short', ''),
          NULLIF(public_profile.descriptions ->> 'summary', ''),
          NULLIF(public_profile.descriptions -> property.default_locale ->> 'short', ''),
          NULLIF(public_profile.descriptions -> property.default_locale ->> 'summary', ''),
          marketplace_prefill.offer_summary,
          marketplace_prefill.host_summary
        ) AS short_description,
        COALESCE(
          NULLIF(public_profile.descriptions ->> 'longDescription', ''),
          NULLIF(public_profile.descriptions ->> 'long_description', ''),
          NULLIF(public_profile.descriptions ->> 'long', ''),
          NULLIF(public_profile.descriptions -> property.default_locale ->> 'long', '')
        ) AS long_description
    ) legacy_description_values ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        legacy_description_values.short_description,
        legacy_description_values.long_description,
        (
          legacy_description_values.short_description IS NOT NULL
          OR legacy_description_values.long_description IS NOT NULL
        ) AS has_description
    ) legacy_description ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        max(value) FILTER (WHERE channel_type = 'website') AS website,
        max(value) FILTER (WHERE channel_type = 'email') AS email,
        COALESCE(
          max(value) FILTER (WHERE channel_type = 'phone'),
          max(value) FILTER (WHERE channel_type = 'whatsapp')
        ) AS phone,
        max(updated_at) AS updated_at
      FROM hotel_catalog.property_contact_channels
      WHERE property_id = property.id
        AND is_public = TRUE
        AND source_system = 'platform'
        AND channel_type IN ('website', 'email', 'phone', 'whatsapp')
    ) contact ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        max(contact.value) FILTER (WHERE contact.channel_type = 'website') AS website,
        max(contact.value) FILTER (WHERE contact.channel_type = 'email') AS email,
        COALESCE(
          max(contact.value) FILTER (WHERE contact.channel_type = 'phone'),
          max(contact.value) FILTER (WHERE contact.channel_type = 'whatsapp')
        ) AS phone
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(public_profile.public_contacts) = 'array'
          THEN public_profile.public_contacts
          ELSE '[]'::jsonb
        END
      ) AS item(value)
      CROSS JOIN LATERAL (
        SELECT
          lower(COALESCE(
            item.value ->> 'type',
            item.value ->> 'kind',
            item.value ->> 'channelType',
            item.value ->> 'channel_type'
          )) AS channel_type,
          NULLIF(item.value ->> 'value', '') AS value
      ) contact
      WHERE contact.value IS NOT NULL
        AND contact.channel_type IN ('website', 'email', 'phone', 'whatsapp')
    ) legacy_contact ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(
          jsonb_build_object(
            'mediaType', media.media_type,
            'url', media.url,
            'altText', media.alt_text,
            'sortOrder', media.sort_order
          )
          ORDER BY media.sort_order, media.created_at, media.id
        ) AS items,
        max(media.updated_at) AS updated_at
      FROM hotel_catalog.property_media media
      WHERE media.property_id = property.id
        AND media.public_approved = TRUE
        AND media.source_system = 'platform'
    ) media ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(
          jsonb_build_object(
            'mediaType',
            CASE
              WHEN item.value ->> 'mediaType' IN ('hero_image', 'gallery_image', 'logo')
                THEN item.value ->> 'mediaType'
              WHEN item.value ->> 'media_type' IN ('hero_image', 'gallery_image', 'logo')
                THEN item.value ->> 'media_type'
              WHEN item.value ->> 'type' IN ('hero_image', 'gallery_image', 'logo')
                THEN item.value ->> 'type'
              WHEN item.value ->> 'type' = 'hero' THEN 'hero_image'
              ELSE 'gallery_image'
            END,
            'url', item.value ->> 'url',
            'altText', COALESCE(item.value ->> 'altText', item.value ->> 'alt_text', item.value ->> 'alt'),
            'sortOrder', CASE
              WHEN item.value ->> 'sortOrder' ~ '^[0-9]+$' THEN (item.value ->> 'sortOrder')::int
              WHEN item.value ->> 'sort_order' ~ '^[0-9]+$' THEN (item.value ->> 'sort_order')::int
              ELSE item.ordinality::int - 1
            END
          )
          ORDER BY item.ordinality
        ) AS items
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(public_profile.media) = 'array' THEN public_profile.media
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS item(value, ordinality)
      WHERE NULLIF(item.value ->> 'url', '') IS NOT NULL
    ) public_profile_media ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(
          jsonb_build_object(
            'mediaType', CASE WHEN image.ordinality = 1 THEN 'hero_image' ELSE 'gallery_image' END,
            'url', image.url,
            'altText', marketplace_prefill.display_name,
            'sortOrder', image.ordinality::int - 1
          )
          ORDER BY image.ordinality
        ) AS items
      FROM unnest(COALESCE(marketplace_prefill.image_urls, ARRAY[]::text[]))
        WITH ORDINALITY AS image(url, ordinality)
      WHERE NULLIF(image.url, '') IS NOT NULL
    ) marketplace_media ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        (
          COALESCE(public_profile_media.items, '[]'::jsonb)
          || COALESCE(marketplace_media.items, '[]'::jsonb)
        ) AS items,
        (
          COALESCE(jsonb_array_length(public_profile_media.items), 0)
          + COALESCE(jsonb_array_length(marketplace_media.items), 0)
        ) > 0 AS has_media
    ) legacy_media ON TRUE
    LEFT JOIN LATERAL (
      SELECT max(value) AS value
      FROM (
        VALUES
          (property.updated_at),
          (catalog_location.updated_at),
          (profile.updated_at),
          (contact.updated_at),
          (media.updated_at),
          (public_profile.projected_at),
          (marketplace_prefill.updated_at)
      ) AS timestamps(value)
    ) updated_at ON TRUE
    WHERE property.id = $2::uuid
    LIMIT 1
  `;
}

function createPropertyProfileSql(): string {
  return `
    WITH profile_input AS (
      SELECT *
      FROM jsonb_to_record($2::jsonb) AS input(
        display_name text,
        property_type text,
        country_code text,
        region text,
        city text,
        street_address text,
        postal_code text,
        raw_marketplace_location text,
        timezone text,
        latitude numeric,
        longitude numeric,
        address_public boolean,
        map_display_mode text,
        short_description text,
        long_description text,
        website text,
        contact_email text,
        phone text,
        media jsonb
      )
    ),
    generated_property AS (
      SELECT gen_random_uuid() AS property_id
    ),
    created_property AS (
      INSERT INTO hotel_catalog.properties (
        id,
        public_id,
        display_name,
        property_type,
        profile_status,
        completeness_reasons
      )
      SELECT
        generated_property.property_id,
        'prop_' || replace(generated_property.property_id::text, '-', ''),
        profile_input.display_name,
        profile_input.property_type,
        $3::text,
        $4::text[]
      FROM generated_property, profile_input
      RETURNING
        id AS property_id,
        public_id,
        default_locale,
        supported_locales,
        profile_status
    ),
    linked_property AS (
      INSERT INTO identity.organization_resource_links (
        organization_id,
        product,
        resource_type,
        resource_id,
        relationship,
        status
      )
      SELECT
        $1::uuid,
        'hotel_catalog',
        'property',
        created_property.property_id::text,
        'owner',
        'active'
      FROM created_property
      ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
      DO UPDATE SET status = 'active', updated_at = now()
      RETURNING product, resource_id
    ),
    linked_product_properties AS (
      INSERT INTO identity.organization_resource_links (
        organization_id,
        product,
        resource_type,
        resource_id,
        relationship,
        status
      )
      SELECT
        $1::uuid,
        entitlement.product,
        CASE entitlement.product
          WHEN 'booking' THEN 'booking_hotel'
          WHEN 'pms' THEN 'pms_property'
          WHEN 'marketplace' THEN 'hotel_profile'
        END,
        created_property.property_id::text,
        'owner',
        'active'
      FROM created_property
      JOIN (
        SELECT product
        FROM identity.product_entitlements
        WHERE organization_id = $1::uuid
          AND (starts_at IS NULL OR starts_at <= now())
          AND (expires_at IS NULL OR expires_at > now())
          AND (
            (product = 'booking' AND entitlement_key IN ('booking-engine', 'account_access'))
            OR (
              product = 'pms'
              AND entitlement_key IN ('property-management', 'pms-core', 'account_access')
            )
            OR (
              product = 'marketplace'
              AND entitlement_key IN ('marketplace-hotel-profile', 'account_access')
            )
          )
        GROUP BY product
        HAVING bool_or(status = 'active') AND NOT bool_or(status = 'suspended')
      ) entitlement ON TRUE
      ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
      DO UPDATE SET status = 'active', updated_at = now()
      RETURNING product, resource_id
    ),
    initialized_marketplace_profile AS (
      INSERT INTO marketplace.marketplace_hotel_profiles (
        property_id,
        organization_id,
        source_system,
        source_hotel_profile_id
      )
      SELECT resource_id::uuid, $1::uuid, 'marketplace', resource_id
      FROM linked_product_properties
      WHERE product = 'marketplace'
      ON CONFLICT (property_id) DO NOTHING
      RETURNING property_id
    ),
    initialized_booking_settings AS (
      INSERT INTO booking.booking_settings (property_id)
      SELECT resource_id::uuid
      FROM linked_product_properties
      WHERE product = 'booking'
      ON CONFLICT (property_id) DO NOTHING
      RETURNING property_id
    ),
    written_property AS (
      SELECT * FROM created_property
    )
    ${propertyProfileMutationCtes()}
    SELECT written_property.property_id::text AS "propertyId"
    FROM written_property
  `;
}

function updatePropertyProfileSql(): string {
  return `
    WITH profile_input AS (
      SELECT *
      FROM jsonb_to_record($3::jsonb) AS input(
        display_name text,
        property_type text,
        country_code text,
        region text,
        city text,
        street_address text,
        postal_code text,
        raw_marketplace_location text,
        timezone text,
        latitude numeric,
        longitude numeric,
        address_public boolean,
        map_display_mode text,
        short_description text,
        long_description text,
        website text,
        contact_email text,
        phone text,
        media jsonb
      )
    ),
    target_property AS (
      SELECT property.id AS property_id
      FROM hotel_catalog.properties property
      JOIN identity.organization_resource_links link
        ON link.organization_id = $1::uuid
       AND link.product = 'hotel_catalog'
       AND link.resource_type = 'property'
       AND link.resource_id = property.id::text
       AND link.relationship IN ('owner', 'operator')
       AND link.status = 'active'
      WHERE property.id = $2::uuid
      LIMIT 1
    ),
    updated_property AS (
      UPDATE hotel_catalog.properties property
      SET display_name = profile_input.display_name,
          property_type = COALESCE(profile_input.property_type, property.property_type),
          profile_status = CASE
            WHEN property.profile_status IN ('disabled', 'private') THEN property.profile_status
            ELSE $4::text
          END,
          completeness_reasons = $5::text[],
          updated_at = now()
      FROM target_property, profile_input
      WHERE property.id = target_property.property_id
        AND NULLIF(BTRIM(property.property_type), '') IS NOT DISTINCT FROM $6::text
      RETURNING
        property.id AS property_id,
        property.public_id,
        property.default_locale,
        property.supported_locales,
        property.profile_status
    ),
    written_property AS (
      SELECT * FROM updated_property
    )
    ${propertyProfileMutationCtes()}
    SELECT written_property.property_id::text AS "propertyId"
    FROM written_property
  `;
}

function propertyProfileMutationCtes(): string {
  return `,
    upserted_location AS (
      INSERT INTO hotel_catalog.property_locations (
        property_id,
        country_code,
        region,
        city,
        street_address,
        postal_code,
        raw_marketplace_location,
        latitude,
        longitude,
        timezone,
        address_public,
        geo_public,
        map_display_mode,
        source_confidence,
        updated_at
      )
      SELECT
        written_property.property_id,
        NULLIF(profile_input.country_code, '')::char(2),
        profile_input.region,
        profile_input.city,
        profile_input.street_address,
        profile_input.postal_code,
        profile_input.raw_marketplace_location,
        profile_input.latitude,
        profile_input.longitude,
        profile_input.timezone,
        COALESCE(profile_input.address_public, TRUE),
        profile_input.latitude IS NOT NULL AND profile_input.longitude IS NOT NULL,
        COALESCE(profile_input.map_display_mode, 'hidden'),
        'verified',
        now()
      FROM written_property, profile_input
      ON CONFLICT (property_id) DO UPDATE
      SET country_code = EXCLUDED.country_code,
          region = EXCLUDED.region,
          city = EXCLUDED.city,
          street_address = EXCLUDED.street_address,
          postal_code = EXCLUDED.postal_code,
          raw_marketplace_location = EXCLUDED.raw_marketplace_location,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          timezone = EXCLUDED.timezone,
          address_public = EXCLUDED.address_public,
          geo_public = EXCLUDED.geo_public,
          map_display_mode = EXCLUDED.map_display_mode,
          source_confidence = EXCLUDED.source_confidence,
          updated_at = now()
      RETURNING property_id
    ),
    upserted_profile AS (
      INSERT INTO hotel_catalog.property_profiles (
        property_id,
        locale,
        short_description,
        long_description,
        source_confidence,
        updated_at
      )
      SELECT
        written_property.property_id,
        written_property.default_locale,
        profile_input.short_description,
        profile_input.long_description,
        'verified',
        now()
      FROM written_property, profile_input
      ON CONFLICT (property_id, locale) DO UPDATE
      SET short_description = EXCLUDED.short_description,
          long_description = EXCLUDED.long_description,
          source_confidence = EXCLUDED.source_confidence,
          updated_at = now()
      RETURNING property_id
    ),
    contact_input AS (
      SELECT written_property.property_id, 'website'::text AS channel_type, profile_input.website AS value
      FROM written_property, profile_input
      UNION ALL
      SELECT written_property.property_id, 'email'::text AS channel_type, profile_input.contact_email AS value
      FROM written_property, profile_input
      UNION ALL
      SELECT written_property.property_id, 'phone'::text AS channel_type, profile_input.phone AS value
      FROM written_property, profile_input
    ),
    deleted_contacts AS (
      DELETE FROM hotel_catalog.property_contact_channels contact
      USING written_property
      WHERE contact.property_id = written_property.property_id
        AND contact.channel_type IN ('website', 'email', 'phone')
        AND contact.source_system = 'platform'
        AND NOT EXISTS (
          SELECT 1
          FROM contact_input
          WHERE contact_input.channel_type = contact.channel_type
            AND contact_input.value IS NOT NULL
            AND contact_input.value = contact.value
        )
      RETURNING contact.property_id
    ),
    upserted_contacts AS (
      INSERT INTO hotel_catalog.property_contact_channels (
        property_id,
        channel_type,
        value,
        is_public,
        source_system,
        updated_at
      )
      SELECT
        contact_input.property_id,
        contact_input.channel_type,
        contact_input.value,
        TRUE,
        'platform',
        now()
      FROM contact_input
      WHERE contact_input.value IS NOT NULL
      ON CONFLICT (property_id, channel_type, value) DO UPDATE
      SET is_public = TRUE,
          source_system = EXCLUDED.source_system,
          updated_at = now()
      RETURNING property_id
    ),
    deleted_media AS (
      DELETE FROM hotel_catalog.property_media media
      USING written_property
      WHERE media.property_id = written_property.property_id
        AND media.source_system = 'platform'
      RETURNING media.property_id
    ),
    media_input AS (
      SELECT
        written_property.property_id,
        media.media_type,
        media.url,
        media.alt_text,
        media.sort_order
      FROM written_property, profile_input
      JOIN LATERAL jsonb_to_recordset(COALESCE(profile_input.media, '[]'::jsonb))
        AS media(media_type text, url text, alt_text text, sort_order int) ON TRUE
    ),
    inserted_media AS (
      INSERT INTO hotel_catalog.property_media (
        property_id,
        media_type,
        url,
        alt_text,
        sort_order,
        source_system,
        public_approved,
        updated_at
      )
      SELECT
        media_input.property_id,
        media_input.media_type,
        media_input.url,
        media_input.alt_text,
        media_input.sort_order,
        'platform',
        TRUE,
        now()
      FROM media_input
      RETURNING property_id
    )
  `;
}

function sharedHotelSetupStatusSql(): string {
  return `
    WITH effective_product_entitlements AS (
      SELECT
        product,
        bool_or(
          status = 'active'
          AND (starts_at IS NULL OR starts_at <= now())
          AND (expires_at IS NULL OR expires_at > now())
        ) AS active,
        bool_or(
          status = 'suspended'
          AND (starts_at IS NULL OR starts_at <= now())
          AND (expires_at IS NULL OR expires_at > now())
        ) AS suspended,
        max(updated_at) AS updated_at
      FROM identity.product_entitlements
      WHERE organization_id = $1::uuid
        AND (
          (product = 'booking' AND entitlement_key IN ('booking-engine', 'account_access'))
          OR (
            product = 'pms'
            AND entitlement_key IN ('property-management', 'pms-core', 'account_access')
          )
          OR (
            product = 'marketplace'
            AND entitlement_key IN ('marketplace-hotel-profile', 'account_access')
          )
        )
      GROUP BY product
    )
    SELECT
      property.id::text AS "propertyId",
      property.public_id AS "publicId",
      COALESCE(
        NULLIF(property.display_name, ''),
        NULLIF(public_profile.display_name, ''),
        marketplace_prefill.display_name
      ) AS "displayName",
      property.profile_status AS "profileStatus",
      CASE
        WHEN (
            NULLIF(property.display_name, '') IS NULL
            AND COALESCE(NULLIF(public_profile.display_name, ''), marketplace_prefill.display_name) IS NOT NULL
          )
          OR (
            COALESCE(legacy_location.location, '{}'::jsonb)
            - ARRAY(SELECT jsonb_object_keys(COALESCE(catalog_location.location, '{}'::jsonb)))
          ) <> '{}'::jsonb
          OR (
            COALESCE(legacy_description.descriptions, '{}'::jsonb)
            - ARRAY(SELECT jsonb_object_keys(COALESCE(catalog_profile.descriptions, '{}'::jsonb)))
          ) <> '{}'::jsonb
          OR legacy_contacts.has_contacts
          OR (COALESCE(jsonb_array_length(catalog_media.media), 0) = 0 AND legacy_media.has_media)
          THEN 'legacy_prefill'
        ELSE 'canonical'
      END AS "profileSource",
      (
        COALESCE(legacy_location.location, '{}'::jsonb)
        || COALESCE(catalog_location.location, '{}'::jsonb)
      ) AS "location",
      (
        COALESCE(legacy_description.descriptions, '{}'::jsonb)
        || COALESCE(catalog_profile.descriptions, '{}'::jsonb)
      ) AS "descriptions",
      CASE
        WHEN COALESCE(jsonb_array_length(catalog_media.media), 0) > 0 THEN catalog_media.media
        ELSE COALESCE(legacy_media.items, '[]'::jsonb)
      END AS "media",
      CASE
        WHEN COALESCE(jsonb_array_length(catalog_contacts.public_contacts), 0) > 0
          THEN catalog_contacts.public_contacts || COALESCE(legacy_contacts.public_contacts, '[]'::jsonb)
        ELSE COALESCE(legacy_contacts.public_contacts, '[]'::jsonb)
      END AS "publicContacts",
      (
        COALESCE(booking_entitlement.active, FALSE)
        OR COALESCE(booking_entitlement.suspended, FALSE)
      ) AS "bookingSelected",
      booking_entitlement.updated_at AS "bookingSelectionUpdatedAt",
      booking_settings.property_id IS NOT NULL AS "hasBookingSettings",
      booking_settings.updated_at AS "bookingSettingsUpdatedAt",
      COALESCE(booking_entitlement.active, FALSE) AS "bookingEntitlementActive",
      COALESCE(booking_entitlement.suspended, FALSE) AS "bookingEntitlementSuspended",
      booking_entitlement.updated_at AS "bookingEntitlementUpdatedAt",
      bookability.profile_status AS "bookabilityStatus",
      bookability.freshness_status AS "bookabilityFreshnessStatus",
      bookability.updated_at AS "bookabilityUpdatedAt",
      payment_settings.payments_enabled AS "paymentsEnabled",
      payment_settings.updated_at AS "paymentSettingsUpdatedAt",
      (
        COALESCE(pms_entitlement.active, FALSE)
        OR COALESCE(pms_entitlement.suspended, FALSE)
      ) AS "pmsSelected",
      pms_entitlement.updated_at AS "pmsSelectionUpdatedAt",
      COALESCE(pms_entitlement.active, FALSE) AS "pmsEntitlementActive",
      COALESCE(pms_entitlement.suspended, FALSE) AS "pmsEntitlementSuspended",
      pms_entitlement.updated_at AS "pmsEntitlementUpdatedAt",
      COALESCE(pms_room_types.count, 0) AS "pmsRoomTypeCount",
      pms_room_types.updated_at AS "pmsRoomUpdatedAt",
      COALESCE(pms_rooms.count, 0) AS "pmsRoomCount",
      COALESCE(pms_rate_plans.count, 0) AS "pmsRatePlanCount",
      pms_rate_plans.updated_at AS "pmsRateUpdatedAt",
      (
        COALESCE(marketplace_entitlement.active, FALSE)
        OR COALESCE(marketplace_entitlement.suspended, FALSE)
      ) AS "marketplaceSelected",
      marketplace_entitlement.updated_at AS "marketplaceSelectionUpdatedAt",
      COALESCE(marketplace_entitlement.active, FALSE) AS "marketplaceEntitlementActive",
      COALESCE(marketplace_entitlement.suspended, FALSE) AS "marketplaceEntitlementSuspended",
      marketplace_entitlement.updated_at AS "marketplaceEntitlementUpdatedAt",
      marketplace_profile.marketplace_profile_status AS "marketplaceProfileStatus",
      marketplace_profile.profile_complete AS "marketplaceProfileComplete",
      marketplace_profile.updated_at AS "marketplaceProfileUpdatedAt",
      COALESCE(marketplace_offers_state.count, 0) AS "marketplaceOfferCount",
      COALESCE(marketplace_offers_state.verified_count, 0) AS "marketplaceVerifiedOfferCount",
      COALESCE(marketplace_offers_state.public_count, 0) AS "marketplacePublicOfferCount",
      marketplace_offers_state.updated_at AS "marketplaceOfferUpdatedAt",
      COALESCE(marketplace_deliverables.count, 0) AS "marketplaceDeliverableCount",
      marketplace_deliverables.updated_at AS "marketplaceDeliverableUpdatedAt",
      COALESCE(marketplace_compensation.count, 0) AS "marketplaceCompensationCount",
      marketplace_compensation.updated_at AS "marketplaceCompensationUpdatedAt",
      COALESCE(marketplace_requirements.count, 0) AS "marketplaceRequirementCount",
      marketplace_requirements.updated_at AS "marketplaceRequirementUpdatedAt"
    FROM unnest($2::uuid[]) AS scoped(property_id)
    JOIN hotel_catalog.properties property
      ON property.id = scoped.property_id
    LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile
      ON public_profile.property_id = property.id
    LEFT JOIN LATERAL (
      SELECT
        NULLIF(listing.title, '') AS display_name,
        NULLIF(listing.raw_location_text, '') AS raw_location_text,
        NULLIF(listing.offer_summary, '') AS offer_summary,
        NULLIF(profile.host_summary, '') AS host_summary,
        listing.image_urls,
        latest.value AS updated_at
      FROM marketplace.marketplace_hotel_profiles profile
      LEFT JOIN LATERAL (
        SELECT title, raw_location_text, offer_summary, image_urls, updated_at
        FROM marketplace.marketplace_offers
        WHERE property_id = property.id
          AND organization_id = $1::uuid
          AND offer_status <> 'archived'
        ORDER BY
          CASE offer_status WHEN 'verified' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
          updated_at DESC,
          id
        LIMIT 1
      ) listing ON TRUE
      LEFT JOIN LATERAL (
        SELECT max(value) AS value
        FROM (VALUES (profile.updated_at), (listing.updated_at)) AS timestamps(value)
      ) latest ON TRUE
      WHERE profile.property_id = property.id
        AND profile.organization_id = $1::uuid
      LIMIT 1
    ) marketplace_prefill ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_strip_nulls(jsonb_build_object(
        'countryCode', NULLIF(location.country_code::text, ''),
        'region', NULLIF(location.region, ''),
        'city', NULLIF(location.city, ''),
        'streetAddress', NULLIF(location.street_address, ''),
        'postalCode', NULLIF(location.postal_code, ''),
        'rawMarketplaceLocation', NULLIF(location.raw_marketplace_location, ''),
        'timezone', NULLIF(location.timezone, ''),
        'latitude', location.latitude,
        'longitude', location.longitude,
        'addressPublic', location.address_public,
        'mapDisplayMode', location.map_display_mode
      )) AS location,
      location.source_confidence,
      (
        NULLIF(location.country_code::text, '') IS NOT NULL
        OR NULLIF(location.city, '') IS NOT NULL
        OR NULLIF(location.raw_marketplace_location, '') IS NOT NULL
      ) AS has_location
      FROM hotel_catalog.property_locations location
      WHERE location.property_id = property.id
    ) catalog_location ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_strip_nulls(jsonb_build_object(
        'shortDescription', NULLIF(profile.short_description, ''),
        'longDescription', NULLIF(profile.long_description, '')
      )) AS descriptions,
      (
        NULLIF(profile.short_description, '') IS NOT NULL
        OR NULLIF(profile.long_description, '') IS NOT NULL
      ) AS has_description
      FROM hotel_catalog.property_profiles profile
      WHERE profile.property_id = property.id
        AND profile.locale = property.default_locale
      LIMIT 1
    ) catalog_profile ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        jsonb_strip_nulls(jsonb_build_object(
          'countryCode', CASE
            WHEN length(COALESCE(
              public_profile.location ->> 'countryCode',
              public_profile.location ->> 'country'
            )) = 2
            THEN upper(COALESCE(
              public_profile.location ->> 'countryCode',
              public_profile.location ->> 'country'
            ))
            ELSE NULL
          END,
          'region', NULLIF(public_profile.location ->> 'region', ''),
          'city', NULLIF(public_profile.location ->> 'city', ''),
          'streetAddress', NULLIF(public_profile.location ->> 'streetAddress', ''),
          'postalCode', NULLIF(public_profile.location ->> 'postalCode', ''),
          'rawMarketplaceLocation', COALESCE(
            NULLIF(public_profile.location ->> 'rawMarketplaceLocation', ''),
            NULLIF(public_profile.location ->> 'display', ''),
            CASE
              WHEN length(NULLIF(public_profile.location ->> 'country', '')) > 2
                THEN NULLIF(public_profile.location ->> 'country', '')
              ELSE NULL
            END,
            marketplace_prefill.raw_location_text
          ),
          'timezone', NULLIF(public_profile.location ->> 'timezone', ''),
          'latitude', CASE
            WHEN COALESCE(public_profile.location ->> 'latitude', public_profile.location #>> '{geo,latitude}')
              ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN COALESCE(public_profile.location ->> 'latitude', public_profile.location #>> '{geo,latitude}')::numeric
            ELSE NULL
          END,
          'longitude', CASE
            WHEN COALESCE(public_profile.location ->> 'longitude', public_profile.location #>> '{geo,longitude}')
              ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN COALESCE(public_profile.location ->> 'longitude', public_profile.location #>> '{geo,longitude}')::numeric
            ELSE NULL
          END,
          'addressPublic', TRUE,
          'mapDisplayMode', CASE
            WHEN public_profile.location ->> 'mapDisplayMode' IN ('hidden', 'approximate', 'exact')
              THEN public_profile.location ->> 'mapDisplayMode'
            WHEN public_profile.location ? 'geo' THEN 'approximate'
            ELSE 'hidden'
          END
        )) AS location,
        (
          NULLIF(public_profile.location ->> 'city', '') IS NOT NULL
          OR NULLIF(public_profile.location ->> 'countryCode', '') IS NOT NULL
          OR NULLIF(public_profile.location ->> 'country', '') IS NOT NULL
          OR NULLIF(public_profile.location ->> 'rawMarketplaceLocation', '') IS NOT NULL
          OR NULLIF(public_profile.location ->> 'display', '') IS NOT NULL
          OR marketplace_prefill.raw_location_text IS NOT NULL
        ) AS has_location
      WHERE catalog_location.source_confidence IS DISTINCT FROM 'verified'
    ) legacy_location ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        jsonb_strip_nulls(jsonb_build_object(
          'shortDescription', COALESCE(
            NULLIF(public_profile.descriptions ->> 'shortDescription', ''),
            NULLIF(public_profile.descriptions ->> 'short_description', ''),
            NULLIF(public_profile.descriptions ->> 'short', ''),
            NULLIF(public_profile.descriptions ->> 'summary', ''),
            NULLIF(public_profile.descriptions -> property.default_locale ->> 'short', ''),
            NULLIF(public_profile.descriptions -> property.default_locale ->> 'summary', ''),
            marketplace_prefill.offer_summary,
            marketplace_prefill.host_summary
          ),
          'longDescription', COALESCE(
            NULLIF(public_profile.descriptions ->> 'longDescription', ''),
            NULLIF(public_profile.descriptions ->> 'long_description', ''),
            NULLIF(public_profile.descriptions ->> 'long', ''),
            NULLIF(public_profile.descriptions -> property.default_locale ->> 'long', '')
          )
        )) AS descriptions
    ) legacy_description_values ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        legacy_description_values.descriptions,
        (
          NULLIF(legacy_description_values.descriptions ->> 'shortDescription', '') IS NOT NULL
          OR NULLIF(legacy_description_values.descriptions ->> 'longDescription', '') IS NOT NULL
        ) AS has_description
    ) legacy_description ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'type', media.media_type,
          'url', media.url,
          'altText', media.alt_text,
          'sortOrder', media.sort_order
        ))
        ORDER BY media.sort_order, media.created_at, media.id
      ) AS media
      FROM hotel_catalog.property_media media
      WHERE media.property_id = property.id
        AND media.public_approved = TRUE
        AND media.source_system = 'platform'
    ) catalog_media ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(
          jsonb_build_object('type', contact.channel_type, 'value', contact.value)
          ORDER BY contact.channel_type, contact.value
        ) AS public_contacts,
        count(*) FILTER (
          WHERE contact.channel_type = 'website'
            AND NULLIF(contact.value, '') IS NOT NULL
        ) > 0 AS has_website,
        count(*) FILTER (
          WHERE contact.channel_type IN ('phone', 'whatsapp')
            AND NULLIF(contact.value, '') IS NOT NULL
        ) > 0 AS has_phone
      FROM hotel_catalog.property_contact_channels contact
      WHERE contact.property_id = property.id
        AND contact.is_public = TRUE
        AND contact.source_system = 'platform'
        AND contact.channel_type IN ('website', 'phone', 'whatsapp')
        AND NULLIF(contact.value, '') IS NOT NULL
    ) catalog_contacts ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(
          jsonb_build_object('type', contact.channel_type, 'value', contact.value)
          ORDER BY contact.channel_type, contact.value
        ) AS public_contacts,
        count(*) > 0 AS has_contacts
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(public_profile.public_contacts) = 'array'
          THEN public_profile.public_contacts
          ELSE '[]'::jsonb
        END
      ) AS item(value)
      CROSS JOIN LATERAL (
        SELECT
          lower(COALESCE(
            item.value ->> 'type',
            item.value ->> 'kind',
            item.value ->> 'channelType',
            item.value ->> 'channel_type'
          )) AS channel_type,
          NULLIF(item.value ->> 'value', '') AS value
      ) contact
      WHERE contact.value IS NOT NULL
        AND contact.channel_type IN ('website', 'phone', 'whatsapp')
        AND (
          (contact.channel_type = 'website' AND COALESCE(catalog_contacts.has_website, FALSE) = FALSE)
          OR (
            contact.channel_type IN ('phone', 'whatsapp')
            AND COALESCE(catalog_contacts.has_phone, FALSE) = FALSE
          )
        )
    ) legacy_contacts ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(
          jsonb_build_object(
            'type',
            CASE
              WHEN item.value ->> 'mediaType' IN ('hero_image', 'gallery_image', 'logo')
                THEN item.value ->> 'mediaType'
              WHEN item.value ->> 'media_type' IN ('hero_image', 'gallery_image', 'logo')
                THEN item.value ->> 'media_type'
              WHEN item.value ->> 'type' IN ('hero_image', 'gallery_image', 'logo')
                THEN item.value ->> 'type'
              WHEN item.value ->> 'type' = 'hero' THEN 'hero_image'
              ELSE 'gallery_image'
            END,
            'url', item.value ->> 'url',
            'altText', COALESCE(item.value ->> 'altText', item.value ->> 'alt_text', item.value ->> 'alt'),
            'sortOrder', CASE
              WHEN item.value ->> 'sortOrder' ~ '^[0-9]+$' THEN (item.value ->> 'sortOrder')::int
              WHEN item.value ->> 'sort_order' ~ '^[0-9]+$' THEN (item.value ->> 'sort_order')::int
              ELSE item.ordinality::int - 1
            END
          )
          ORDER BY item.ordinality
        ) AS items
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(public_profile.media) = 'array' THEN public_profile.media
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS item(value, ordinality)
      WHERE NULLIF(item.value ->> 'url', '') IS NOT NULL
    ) public_profile_media ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(
          jsonb_build_object(
            'type', CASE WHEN image.ordinality = 1 THEN 'hero_image' ELSE 'gallery_image' END,
            'url', image.url,
            'altText', marketplace_prefill.display_name,
            'sortOrder', image.ordinality::int - 1
          )
          ORDER BY image.ordinality
        ) AS items
      FROM unnest(COALESCE(marketplace_prefill.image_urls, ARRAY[]::text[]))
        WITH ORDINALITY AS image(url, ordinality)
      WHERE NULLIF(image.url, '') IS NOT NULL
    ) marketplace_media ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        (
          COALESCE(public_profile_media.items, '[]'::jsonb)
          || COALESCE(marketplace_media.items, '[]'::jsonb)
        ) AS items,
        (
          COALESCE(jsonb_array_length(public_profile_media.items), 0)
          + COALESCE(jsonb_array_length(marketplace_media.items), 0)
        ) > 0 AS has_media
    ) legacy_media ON TRUE
    LEFT JOIN booking.booking_settings booking_settings
      ON booking_settings.property_id = property.id
    LEFT JOIN distribution.public_hotel_bookability_profiles bookability
      ON bookability.property_id = property.id
    LEFT JOIN finance.payment_settings payment_settings
      ON payment_settings.property_id = property.id
    LEFT JOIN effective_product_entitlements booking_entitlement
      ON booking_entitlement.product = 'booking'
    LEFT JOIN effective_product_entitlements pms_entitlement
      ON pms_entitlement.product = 'pms'
    LEFT JOIN effective_product_entitlements marketplace_entitlement
      ON marketplace_entitlement.product = 'marketplace'
    LEFT JOIN marketplace.marketplace_hotel_profiles marketplace_profile
      ON marketplace_profile.property_id = property.id
     AND marketplace_profile.organization_id = $1::uuid
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count, max(updated_at) AS updated_at
      FROM pms.room_types
      WHERE property_id = property.id
        AND active = TRUE
    ) pms_room_types ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count, max(updated_at) AS updated_at
      FROM pms.rooms
      WHERE property_id = property.id
        AND status <> 'retired'
    ) pms_rooms ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count, max(updated_at) AS updated_at
      FROM pms.rate_plans
      WHERE property_id = property.id
        AND active = TRUE
    ) pms_rate_plans ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE offer.offer_status IN ('pending', 'verified'))::int AS count,
        count(*) FILTER (WHERE offer.offer_status = 'verified')::int AS verified_count,
        count(*) FILTER (
          WHERE offer.offer_status = 'verified'
            AND projection.visibility_status = 'public'
        )::int AS public_count,
        max(offer.updated_at) FILTER (
          WHERE offer.offer_status IN ('pending', 'verified')
        ) AS updated_at
      FROM marketplace.marketplace_offers offer
      LEFT JOIN marketplace.marketplace_offer_read_model projection
        ON projection.offer_id = offer.id
       AND projection.property_id = offer.property_id
      WHERE offer.property_id = property.id
        AND offer.organization_id = $1::uuid
    ) marketplace_offers_state ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count, max(deliverable.updated_at) AS updated_at
      FROM marketplace.offer_deliverables deliverable
      JOIN marketplace.marketplace_offers offer
        ON offer.id = deliverable.offer_id
       AND offer.property_id = deliverable.property_id
       AND offer.organization_id = deliverable.organization_id
      WHERE deliverable.property_id = property.id
        AND deliverable.organization_id = $1::uuid
        AND offer.offer_status IN ('pending', 'verified')
    ) marketplace_deliverables ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count, max(offering.updated_at) AS updated_at
      FROM marketplace.offer_compensation_options offering
      JOIN marketplace.marketplace_offers listing
        ON listing.id = offering.offer_id
       AND listing.property_id = offering.property_id
       AND listing.organization_id = offering.organization_id
      WHERE offering.property_id = property.id
        AND offering.organization_id = $1::uuid
        AND listing.offer_status IN ('pending', 'verified')
    ) marketplace_compensation ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count, max(requirement.updated_at) AS updated_at
      FROM marketplace.offer_creator_requirements requirement
      JOIN marketplace.marketplace_offers listing
        ON listing.id = requirement.offer_id
       AND listing.property_id = requirement.property_id
       AND listing.organization_id = requirement.organization_id
      WHERE requirement.property_id = property.id
        AND requirement.organization_id = $1::uuid
        AND listing.offer_status IN ('pending', 'verified')
    ) marketplace_requirements ON TRUE
    ORDER BY array_position($2::uuid[], property.id)
  `;
}

function organizationProductSelectionsSql(): string {
  return `
    WITH effective_product_entitlements AS (
      SELECT
        product,
        bool_or(status = 'active') AS active,
        bool_or(status = 'suspended') AS suspended,
        max(updated_at) AS updated_at
      FROM identity.product_entitlements
      WHERE organization_id = $1::uuid
        AND product = ANY($2::text[])
        AND (starts_at IS NULL OR starts_at <= now())
        AND (expires_at IS NULL OR expires_at > now())
        AND (
          (product = 'booking' AND entitlement_key IN ('booking-engine', 'account_access'))
          OR (
            product = 'pms'
            AND entitlement_key IN ('property-management', 'pms-core', 'account_access')
          )
          OR (
            product = 'marketplace'
            AND entitlement_key IN ('marketplace-hotel-profile', 'account_access')
          )
        )
      GROUP BY product
    )
    SELECT product, updated_at
    FROM effective_product_entitlements
    WHERE active AND NOT suspended
    ORDER BY CASE product
      WHEN 'booking' THEN 1
      WHEN 'pms' THEN 2
      WHEN 'marketplace' THEN 3
      ELSE 4
    END
  `;
}

function organizationProductSelectionsWriteSql(): string {
  return `
    WITH requested(product, entitlement_key) AS (
      SELECT
        product,
        CASE product
          WHEN 'booking' THEN 'booking-engine'
          WHEN 'pms' THEN 'property-management'
          WHEN 'marketplace' THEN 'marketplace-hotel-profile'
        END
      FROM (SELECT DISTINCT unnest($2::text[]) AS product) selected
    ),
    upserted AS (
      INSERT INTO identity.product_entitlements (
        organization_id,
        product,
        entitlement_key,
        status,
        starts_at,
        expires_at,
        metadata
      )
      SELECT
        $1::uuid,
        product,
        entitlement_key,
        'active',
        now(),
        NULL,
        jsonb_build_object('source', 'shared_hotel_setup')
      FROM requested
      WHERE NOT EXISTS (
        SELECT 1
        FROM identity.product_entitlements suspended
        WHERE suspended.organization_id = $1::uuid
          AND suspended.product = requested.product
          AND suspended.status = 'suspended'
          AND (suspended.starts_at IS NULL OR suspended.starts_at <= now())
          AND (suspended.expires_at IS NULL OR suspended.expires_at > now())
          AND (
            suspended.entitlement_key IN (requested.entitlement_key, 'account_access')
            OR (requested.product = 'pms' AND suspended.entitlement_key = 'pms-core')
          )
      )
      ON CONFLICT (
        organization_id,
        product,
        entitlement_key,
        COALESCE(resource_product, ''),
        COALESCE(resource_type, ''),
        COALESCE(resource_id, '')
      ) DO UPDATE SET
        status = 'active',
        starts_at = CASE
          WHEN identity.product_entitlements.status = 'expired'
            OR (
              identity.product_entitlements.status = 'suspended'
              AND identity.product_entitlements.expires_at IS NOT NULL
              AND identity.product_entitlements.expires_at <= now()
            )
            THEN now()
          ELSE COALESCE(identity.product_entitlements.starts_at, now())
        END,
        expires_at = NULL,
        metadata = identity.product_entitlements.metadata || EXCLUDED.metadata,
        updated_at = now()
      WHERE (
          identity.product_entitlements.metadata ->> 'source' = 'shared_hotel_setup'
          AND identity.product_entitlements.status IN ('active', 'expired')
        )
        OR (
          identity.product_entitlements.status = 'suspended'
          AND identity.product_entitlements.expires_at IS NOT NULL
          AND identity.product_entitlements.expires_at <= now()
        )
      RETURNING product, updated_at
    ),
    expired AS (
      UPDATE identity.product_entitlements
      SET
        status = 'expired',
        expires_at = COALESCE(expires_at, now()),
        metadata = metadata || jsonb_build_object('source', 'shared_hotel_setup'),
        updated_at = now()
      WHERE organization_id = $1::uuid
        AND product = ANY($3::text[])
        AND resource_product IS NULL
        AND resource_type IS NULL
        AND resource_id IS NULL
        AND status = 'active'
        AND metadata ->> 'source' = 'shared_hotel_setup'
        AND entitlement_key IN (
          'booking-engine',
          'property-management',
          'marketplace-hotel-profile'
        )
        AND NOT (product = ANY($2::text[]))
      RETURNING product, updated_at
    ),
    organization_properties AS (
      SELECT link.resource_id, link.relationship
      FROM identity.organization_resource_links link
      JOIN hotel_catalog.properties property
        ON property.id::text = link.resource_id
      WHERE link.organization_id = $1::uuid
        AND link.product = 'hotel_catalog'
        AND link.resource_type = 'property'
        AND link.status = 'active'
        AND link.relationship IN ('owner', 'operator')
    ),
    requested_state AS (
      SELECT
        requested.product,
        COALESCE(
          bool_or(
            upserted.product IS NOT NULL
            OR (
              entitlement.status = 'active'
              AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
              AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
            )
          ),
          false
        ) AS active,
        COALESCE(
          bool_or(
            entitlement.status = 'suspended'
            AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
            AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
          ),
          false
        ) AS suspended
      FROM requested
      LEFT JOIN upserted
        ON upserted.product = requested.product
      LEFT JOIN identity.product_entitlements entitlement
        ON entitlement.organization_id = $1::uuid
       AND entitlement.product = requested.product
       AND (
         entitlement.entitlement_key IN (requested.entitlement_key, 'account_access')
         OR (requested.product = 'pms' AND entitlement.entitlement_key = 'pms-core')
       )
      GROUP BY requested.product
    ),
    active_requested AS (
      SELECT product
      FROM requested_state
      WHERE active AND NOT suspended
    ),
    linked_product_properties AS (
      INSERT INTO identity.organization_resource_links (
        organization_id,
        product,
        resource_type,
        resource_id,
        relationship,
        status
      )
      SELECT
        $1::uuid,
        active_requested.product,
        CASE active_requested.product
          WHEN 'booking' THEN 'booking_hotel'
          WHEN 'pms' THEN 'pms_property'
          WHEN 'marketplace' THEN 'hotel_profile'
        END,
        organization_properties.resource_id,
        organization_properties.relationship,
        'active'
      FROM active_requested
      CROSS JOIN organization_properties
      ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
      DO UPDATE SET status = 'active', updated_at = now()
      WHERE identity.organization_resource_links.status <> 'suspended'
      RETURNING product, resource_id
    ),
    initialized_marketplace_profiles AS (
      INSERT INTO marketplace.marketplace_hotel_profiles (
        property_id,
        organization_id,
        source_system,
        source_hotel_profile_id
      )
      SELECT resource_id::uuid, $1::uuid, 'marketplace', resource_id
      FROM linked_product_properties
      WHERE product = 'marketplace'
      ON CONFLICT (property_id) DO NOTHING
      RETURNING property_id
    ),
    initialized_booking_settings AS (
      INSERT INTO booking.booking_settings (property_id)
      SELECT resource_id::uuid
      FROM linked_product_properties
      WHERE product = 'booking'
      ON CONFLICT (property_id) DO NOTHING
      RETURNING property_id
    ),
    selected_after_write AS (
      SELECT
        active_requested.product,
        COALESCE(max(upserted.updated_at), max(entitlement.updated_at), now()) AS updated_at
      FROM active_requested
      LEFT JOIN upserted
        ON upserted.product = active_requested.product
      LEFT JOIN identity.product_entitlements entitlement
        ON entitlement.organization_id = $1::uuid
       AND entitlement.product = active_requested.product
       AND entitlement.status = 'active'
       AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
       AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
       AND (
         (entitlement.product = 'booking' AND entitlement.entitlement_key IN ('booking-engine', 'account_access'))
         OR (
           entitlement.product = 'pms'
           AND entitlement.entitlement_key IN ('property-management', 'pms-core', 'account_access')
         )
         OR (
           entitlement.product = 'marketplace'
           AND entitlement.entitlement_key IN ('marketplace-hotel-profile', 'account_access')
         )
       )
      GROUP BY active_requested.product

      UNION ALL

      SELECT entitlement.product, max(entitlement.updated_at) AS updated_at
      FROM identity.product_entitlements entitlement
      WHERE entitlement.organization_id = $1::uuid
        AND entitlement.product = ANY($3::text[])
        AND NOT (entitlement.product = ANY($2::text[]))
        AND entitlement.status = 'active'
        AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
        AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
        AND entitlement.metadata ->> 'source' IS DISTINCT FROM 'shared_hotel_setup'
        AND (
          (entitlement.product = 'booking' AND entitlement.entitlement_key IN ('booking-engine', 'account_access'))
          OR (
            entitlement.product = 'pms'
            AND entitlement.entitlement_key IN ('property-management', 'pms-core', 'account_access')
          )
          OR (
            entitlement.product = 'marketplace'
            AND entitlement.entitlement_key IN ('marketplace-hotel-profile', 'account_access')
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM identity.product_entitlements suspended
          WHERE suspended.organization_id = $1::uuid
            AND suspended.product = entitlement.product
            AND suspended.status = 'suspended'
            AND (suspended.starts_at IS NULL OR suspended.starts_at <= now())
            AND (suspended.expires_at IS NULL OR suspended.expires_at > now())
            AND (
              suspended.entitlement_key IN (
                CASE suspended.product
                  WHEN 'booking' THEN 'booking-engine'
                  WHEN 'pms' THEN 'property-management'
                  WHEN 'marketplace' THEN 'marketplace-hotel-profile'
                END,
                'account_access'
              )
              OR (suspended.product = 'pms' AND suspended.entitlement_key = 'pms-core')
            )
        )
      GROUP BY entitlement.product
    )
    SELECT product, max(updated_at) AS updated_at
    FROM selected_after_write
    GROUP BY product
    ORDER BY CASE product
      WHEN 'booking' THEN 1
      WHEN 'pms' THEN 2
      WHEN 'marketplace' THEN 3
      ELSE 4
    END
  `;
}

function hasLocation(value: unknown): boolean {
  const location = objectValue(value);
  return ["rawMarketplaceLocation", "city", "countryCode", "country"].some((key) =>
    nonEmpty(location[key]),
  );
}

function locationSummary(value: unknown): string | null {
  const location = objectValue(value);
  const parts = [
    location["city"],
    location["region"],
    location["countryCode"] ?? location["country"],
  ]
    .map((item) => nonEmpty(item))
    .filter((item): item is string => item !== null);
  return parts.length > 0 ? parts.join(", ") : nonEmpty(location["rawMarketplaceLocation"]);
}

function hasDescription(value: unknown): boolean {
  const descriptions = objectValue(value);
  return [
    "shortDescription",
    "longDescription",
    "short_description",
    "long_description",
    "short",
    "long",
    "summary",
  ].some((key) => nonEmpty(descriptions[key]));
}

function hasMedia(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function mediaItems(value: unknown): SharedPropertyProfileMedia[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index): SharedPropertyProfileMedia | null => {
      const media = objectValue(item);
      const url = nonEmpty(media["url"]);
      if (!url) return null;
      const mediaTypeValue = nonEmpty(media["mediaType"] ?? media["media_type"] ?? media["type"]);
      const sortOrderValue = media["sortOrder"] ?? media["sort_order"];
      const parsedSortOrder =
        typeof sortOrderValue === "number"
          ? sortOrderValue
          : Number.parseInt(String(sortOrderValue), 10);
      return {
        mediaType:
          mediaTypeValue === "hero" || mediaTypeValue === "hero_image"
            ? "hero_image"
            : mediaTypeValue === "logo"
              ? mediaTypeValue
              : "gallery_image",
        url,
        altText: nonEmpty(media["altText"] ?? media["alt_text"] ?? media["alt"]),
        sortOrder: Number.isFinite(parsedSortOrder) ? parsedSortOrder : index,
      };
    })
    .filter((item): item is SharedPropertyProfileMedia => item !== null);
}

function hasContact(value: unknown, types: string[]): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    const contact = objectValue(entry);
    const type = nonEmpty(
      contact["type"] ?? contact["kind"] ?? contact["channelType"] ?? contact["channel_type"],
    );
    const contactValue = nonEmpty(contact["value"]);
    return Boolean(type && contactValue && types.includes(type));
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toCount(value: number | string): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10) || 0;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mapDisplayMode(value: string | null): SharedPropertyProfileLocation["mapDisplayMode"] {
  if (value === "approximate" || value === "exact") return value;
  return "hidden";
}

function latest(...values: unknown[]): string | null {
  const timestamps = values
    .map((value) => {
      const iso = toIsoString(value);
      return iso ? Date.parse(iso) : Number.NaN;
    })
    .filter(Number.isFinite);
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
