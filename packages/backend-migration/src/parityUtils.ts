import type pg from "pg";

import type { ExpectedTarget, ParityFinding } from "./parityTypes.js";

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPECTED_TARGET_KEYS = new Set([
  "counts",
  "idStability",
  "uniquenessChecks",
  "identityChecks",
  "catalogPublicProfileChecks",
  "bookingCheckoutChecks",
  "financeChecks",
  "pmsOperationsChecks",
  "marketplaceChecks",
  "distributionBookabilityChecks",
  "platformMediaChecks",
  "mediaUrlMigrationChecks",
]);
const IDENTITY_CHECK_KEYS = new Set([
  "memberships",
  "resourceLinks",
  "entitlements",
  "rolePermissionGrants",
  "permissionKeys",
]);
const CATALOG_PUBLIC_PROFILE_CHECK_KEYS = new Set([
  "completePropertyIds",
  "missingLocationPropertyIds",
  "customDomainProperties",
  "forbiddenPublicProfileKeys",
]);
const BOOKING_CHECKOUT_CHECK_KEYS = new Set(["flows", "settings", "forbiddenSummaryKeys"]);
const FINANCE_CHECK_KEYS = new Set([
  "propertyFlows",
  "affiliatePayouts",
  "forbiddenVisibilityKeys",
]);
const PMS_OPERATIONS_CHECK_KEYS = new Set(["properties", "forbiddenOperationalSummaryKeys"]);
const MARKETPLACE_CHECK_KEYS = new Set(["slices", "forbiddenPublicReadModelValues"]);
const MARKETPLACE_SLICE_STRING_FIELDS = [
  "propertyId",
  "hotelOrganizationId",
  "hotelOwnerUserId",
  "hotelOwnerRoleKey",
  "creatorProfileId",
  "creatorOrganizationId",
  "creatorOwnerUserId",
  "creatorOwnerRoleKey",
  "offerId",
  "commissionRuleId",
  "creatorPlatformId",
  "creatorRatingId",
  "compensationOptionFreeStayId",
  "compensationOptionAffiliateId",
  "compensationOptionPaidId",
  "compensationOptionDiscountId",
  "requirementId",
  "collaborationId",
  "paidCollaborationId",
  "discountCollaborationId",
  "deliverableApprovedId",
  "deliverableSubmittedId",
  "creatorChatMessageId",
  "hotelChatMessageId",
  "tripId",
  "externalCollaborationId",
  "unreadNotificationId",
  "readNotificationId",
  "pendingInviteCodeId",
  "redeemedInviteCodeId",
  "creatorNewsletterPreferenceId",
  "hotelNewsletterPreferenceId",
  "sourceCreatorId",
  "sourceHotelProfileId",
  "sourceOfferId",
  "sourceCollaborationId",
  "creatorDisplayName",
  "platform",
  "offerPublicId",
  "offerSlug",
  "visibilityStatus",
  "lifecycleStatus",
  "affiliateReferralCode",
  "creatorChatBody",
  "hotelChatBody",
  "tripName",
  "externalCollaborationTitle",
  "pendingInviteCode",
  "redeemedInviteCode",
];
const MARKETPLACE_SLICE_INTEGER_FIELDS = [
  "compensationOptionCount",
  "deliverableCount",
  "chatMessageCount",
  "notificationCount",
  "inviteCodeCount",
  "newsletterPreferenceCount",
  "rating",
  "platformFollowerCount",
];
const DISTRIBUTION_BOOKABILITY_CHECK_KEYS = new Set(["properties", "forbiddenPublicOutputValues"]);
const PLATFORM_MEDIA_CHECK_KEYS = new Set([
  "legacyUrlInventory",
  "requiredPurposes",
  "requiredPublicVariants",
  "forbiddenPublicValues",
]);
const PLATFORM_MEDIA_INVENTORY_KEYS = new Set([
  "sourceUrlCount",
  "copiedObjectCount",
  "externalReferenceCount",
  "unresolvedExternalUrlCount",
  "publicObjectCount",
  "privateObjectCount",
]);
const MEDIA_URL_MIGRATION_CHECK_KEYS = new Set([
  "bookingPropertyMedia",
  "propertyPublicProfiles",
  "marketplace",
  "pms",
  "forbiddenPublicReferenceValues",
]);
const MEDIA_URL_BOOKING_PROPERTY_MEDIA_STRING_FIELDS = ["id", "mediaType", "url", "sourceSystem"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addInvalidFixtureConfigFinding(
  findings: ParityFinding[],
  targetObject: string,
  message: string,
  expected: string,
  actual: string,
): void {
  findings.push({
    severity: "fail",
    code: "INVALID_FIXTURE_CONFIG",
    owner: "Parity harness",
    targetObject,
    message,
    expected,
    actual,
    suggestedAction: "Fix expected-target.json before running parity checks.",
  });
}

function describeActual(value: unknown): string {
  if (value === undefined) return "undefined";
  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

function validateKnownKeys(
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
  targetObject: string,
  findings: ParityFinding[],
): void {
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) continue;

    addInvalidFixtureConfigFinding(
      findings,
      `${targetObject}.${key}`,
      `Unknown expected-target.json key ${key}`,
      `One of: ${Array.from(allowedKeys).join(", ")}`,
      key,
    );
  }
}

function validateStringArray(
  value: unknown,
  targetObject: string,
  findings: ParityFinding[],
): void {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return;

  addInvalidFixtureConfigFinding(
    findings,
    targetObject,
    `${targetObject} must be an array of strings when present`,
    "string[]",
    describeActual(value),
  );
}

function validateNonNegativeIntegerObject(
  value: unknown,
  targetObject: string,
  allowedKeys: Set<string>,
  findings: ParityFinding[],
): void {
  if (!isRecord(value)) {
    addInvalidFixtureConfigFinding(
      findings,
      targetObject,
      `${targetObject} must be an object`,
      "Record<string, non-negative integer>",
      describeActual(value),
    );
    return;
  }

  validateKnownKeys(value, allowedKeys, targetObject, findings);

  for (const key of allowedKeys) {
    const item = value[key];
    if (typeof item === "number" && Number.isInteger(item) && item >= 0) continue;

    addInvalidFixtureConfigFinding(
      findings,
      `${targetObject}.${key}`,
      `${targetObject}.${key} must be a non-negative integer`,
      "non-negative integer",
      describeActual(item),
    );
  }
}

function validateObjectArray(
  value: unknown,
  targetObject: string,
  requiredStringFields: string[],
  findings: ParityFinding[],
  nullableStringFields: string[] = [],
  requiredIntegerFields: string[] = [],
): void {
  if (!Array.isArray(value)) {
    addInvalidFixtureConfigFinding(
      findings,
      targetObject,
      `${targetObject} must be an array of objects when present`,
      "object[]",
      describeActual(value),
    );
    return;
  }

  value.forEach((item, index) => {
    const itemTarget = `${targetObject}[${index}]`;
    if (!isRecord(item)) {
      addInvalidFixtureConfigFinding(
        findings,
        itemTarget,
        `${itemTarget} must be an object`,
        "object",
        describeActual(item),
      );
      return;
    }

    for (const field of requiredStringFields) {
      if (typeof item[field] === "string") continue;

      addInvalidFixtureConfigFinding(
        findings,
        `${itemTarget}.${field}`,
        `${itemTarget}.${field} must be a string`,
        "string",
        describeActual(item[field]),
      );
    }

    for (const field of nullableStringFields) {
      if (typeof item[field] === "string" || item[field] === null) continue;

      addInvalidFixtureConfigFinding(
        findings,
        `${itemTarget}.${field}`,
        `${itemTarget}.${field} must be a string or null`,
        "string | null",
        describeActual(item[field]),
      );
    }

    for (const field of requiredIntegerFields) {
      if (typeof item[field] === "number" && Number.isInteger(item[field]) && item[field] >= 0) {
        continue;
      }

      addInvalidFixtureConfigFinding(
        findings,
        `${itemTarget}.${field}`,
        `${itemTarget}.${field} must be a non-negative integer`,
        "non-negative integer",
        describeActual(item[field]),
      );
    }
  });
}

export function parseTableRef(
  tableRef: string,
  findings: ParityFinding[],
): { schema: string; table: string } | null {
  const parts = tableRef.split(".");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !SAFE_IDENTIFIER.test(parts[0]) ||
    !SAFE_IDENTIFIER.test(parts[1])
  ) {
    findings.push({
      severity: "fail",
      code: "INVALID_FIXTURE_CONFIG",
      owner: "Parity harness",
      targetObject: tableRef,
      message: `Malformed table reference "${tableRef}" in expected-target.json — expected "schema.table"`,
      expected: "schema.table",
      actual: tableRef,
      suggestedAction: `Fix the table reference in expected-target.json.`,
    });
    return null;
  }
  return { schema: parts[0], table: parts[1] };
}

export function validateExpectedTargetConfig(
  expected: unknown,
  findings: ParityFinding[],
): expected is ExpectedTarget {
  if (!isRecord(expected)) {
    addInvalidFixtureConfigFinding(
      findings,
      "expected-target.json",
      "expected-target.json must contain a JSON object",
      "object",
      Array.isArray(expected) ? "array" : typeof expected,
    );
    return false;
  }
  validateKnownKeys(expected, EXPECTED_TARGET_KEYS, "expected-target.json", findings);

  if (!isRecord(expected["counts"])) {
    addInvalidFixtureConfigFinding(
      findings,
      "expected-target.json.counts",
      "expected-target.json counts must be an object keyed by schema.table",
      "Record<schema.table, non-negative integer>",
      Array.isArray(expected["counts"]) ? "array" : typeof expected["counts"],
    );
  } else {
    for (const [tableRef, count] of Object.entries(expected["counts"])) {
      parseTableRef(tableRef, findings);
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        addInvalidFixtureConfigFinding(
          findings,
          `expected-target.json.counts.${tableRef}`,
          `Invalid expected row count for ${tableRef}`,
          "non-negative integer",
          JSON.stringify(count),
        );
      }
    }
  }

  if (!isRecord(expected["idStability"])) {
    addInvalidFixtureConfigFinding(
      findings,
      "expected-target.json.idStability",
      "expected-target.json idStability must be an object keyed by schema.table",
      "Record<schema.table, string[]>",
      Array.isArray(expected["idStability"]) ? "array" : typeof expected["idStability"],
    );
  } else {
    for (const [tableRef, ids] of Object.entries(expected["idStability"])) {
      parseTableRef(tableRef, findings);
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
        addInvalidFixtureConfigFinding(
          findings,
          `expected-target.json.idStability.${tableRef}`,
          `Invalid ID stability list for ${tableRef}`,
          "string[]",
          JSON.stringify(ids),
        );
      }
    }
  }

  const uniquenessChecks = expected["uniquenessChecks"];
  if (
    uniquenessChecks !== undefined &&
    (!Array.isArray(uniquenessChecks) ||
      !uniquenessChecks.every((check) => typeof check === "string"))
  ) {
    addInvalidFixtureConfigFinding(
      findings,
      "expected-target.json.uniquenessChecks",
      "expected-target.json uniquenessChecks must be an array of strings when present",
      "string[]",
      JSON.stringify(uniquenessChecks),
    );
  }

  for (const extensionKey of [
    "identityChecks",
    "catalogPublicProfileChecks",
    "bookingCheckoutChecks",
    "financeChecks",
    "pmsOperationsChecks",
    "marketplaceChecks",
    "distributionBookabilityChecks",
    "platformMediaChecks",
    "mediaUrlMigrationChecks",
  ]) {
    const extension = expected[extensionKey];
    if (extension !== undefined && !isRecord(extension)) {
      addInvalidFixtureConfigFinding(
        findings,
        `expected-target.json.${extensionKey}`,
        `expected-target.json ${extensionKey} must be an object when present`,
        "object",
        Array.isArray(extension) ? "array" : typeof extension,
      );
    }
  }

  const identityChecks = expected["identityChecks"];
  if (isRecord(identityChecks)) {
    validateKnownKeys(
      identityChecks,
      IDENTITY_CHECK_KEYS,
      "expected-target.json.identityChecks",
      findings,
    );
    if (identityChecks["memberships"] !== undefined) {
      validateObjectArray(
        identityChecks["memberships"],
        "expected-target.json.identityChecks.memberships",
        ["organizationId", "userId", "status", "roleKey"],
        findings,
      );
    }
    if (identityChecks["resourceLinks"] !== undefined) {
      validateObjectArray(
        identityChecks["resourceLinks"],
        "expected-target.json.identityChecks.resourceLinks",
        ["organizationId", "product", "resourceType", "resourceId", "relationship", "status"],
        findings,
      );
    }
    if (identityChecks["entitlements"] !== undefined) {
      validateObjectArray(
        identityChecks["entitlements"],
        "expected-target.json.identityChecks.entitlements",
        ["organizationId", "product", "entitlementKey", "status"],
        findings,
        ["resourceProduct", "resourceType", "resourceId"],
      );
    }
    if (identityChecks["rolePermissionGrants"] !== undefined) {
      validateObjectArray(
        identityChecks["rolePermissionGrants"],
        "expected-target.json.identityChecks.rolePermissionGrants",
        ["organizationKind", "roleKey", "permissionKey"],
        findings,
      );
    }
    if (identityChecks["permissionKeys"] !== undefined) {
      validateStringArray(
        identityChecks["permissionKeys"],
        "expected-target.json.identityChecks.permissionKeys",
        findings,
      );
    }
  }

  const catalogPublicProfileChecks = expected["catalogPublicProfileChecks"];
  if (isRecord(catalogPublicProfileChecks)) {
    validateKnownKeys(
      catalogPublicProfileChecks,
      CATALOG_PUBLIC_PROFILE_CHECK_KEYS,
      "expected-target.json.catalogPublicProfileChecks",
      findings,
    );
    if (catalogPublicProfileChecks["completePropertyIds"] !== undefined) {
      validateStringArray(
        catalogPublicProfileChecks["completePropertyIds"],
        "expected-target.json.catalogPublicProfileChecks.completePropertyIds",
        findings,
      );
    }
    if (catalogPublicProfileChecks["missingLocationPropertyIds"] !== undefined) {
      validateStringArray(
        catalogPublicProfileChecks["missingLocationPropertyIds"],
        "expected-target.json.catalogPublicProfileChecks.missingLocationPropertyIds",
        findings,
      );
    }
    if (catalogPublicProfileChecks["customDomainProperties"] !== undefined) {
      validateObjectArray(
        catalogPublicProfileChecks["customDomainProperties"],
        "expected-target.json.catalogPublicProfileChecks.customDomainProperties",
        ["propertyId", "hostname"],
        findings,
      );
    }
    if (catalogPublicProfileChecks["forbiddenPublicProfileKeys"] !== undefined) {
      validateStringArray(
        catalogPublicProfileChecks["forbiddenPublicProfileKeys"],
        "expected-target.json.catalogPublicProfileChecks.forbiddenPublicProfileKeys",
        findings,
      );
    }
  }

  const bookingCheckoutChecks = expected["bookingCheckoutChecks"];
  if (isRecord(bookingCheckoutChecks)) {
    validateKnownKeys(
      bookingCheckoutChecks,
      BOOKING_CHECKOUT_CHECK_KEYS,
      "expected-target.json.bookingCheckoutChecks",
      findings,
    );
    validateObjectArray(
      bookingCheckoutChecks["flows"],
      "expected-target.json.bookingCheckoutChecks.flows",
      [
        "propertyId",
        "organizationId",
        "bookingHotelResourceId",
        "quoteSessionId",
        "checkoutContextId",
        "guestBookingId",
        "paymentId",
        "publicQuoteReference",
        "publicBookingReference",
        "lifecycleStatus",
        "paymentStatus",
        "paymentAmount",
        "currency",
      ],
      findings,
      [],
      ["guestCount", "addonSelectionCount", "promoApplicationCount", "statusEventCount"],
    );
    if (bookingCheckoutChecks["settings"] !== undefined) {
      validateObjectArray(
        bookingCheckoutChecks["settings"],
        "expected-target.json.bookingCheckoutChecks.settings",
        [
          "propertyId",
          "bookingHotelResourceId",
          "defaultCurrency",
          "defaultLanguage",
          "acceptanceMode",
        ],
        findings,
      );
    }
    if (bookingCheckoutChecks["forbiddenSummaryKeys"] !== undefined) {
      validateStringArray(
        bookingCheckoutChecks["forbiddenSummaryKeys"],
        "expected-target.json.bookingCheckoutChecks.forbiddenSummaryKeys",
        findings,
      );
    }
  }

  const financeChecks = expected["financeChecks"];
  if (isRecord(financeChecks)) {
    validateKnownKeys(
      financeChecks,
      FINANCE_CHECK_KEYS,
      "expected-target.json.financeChecks",
      findings,
    );
    if (financeChecks["propertyFlows"] !== undefined) {
      validateObjectArray(
        financeChecks["propertyFlows"],
        "expected-target.json.financeChecks.propertyFlows",
        [
          "propertyId",
          "organizationId",
          "ownerUserId",
          "bookingHotelResourceId",
          "pmsHotelResourceId",
          "providerAccountId",
          "paymentId",
          "guestBookingId",
          "payoutSettingsId",
          "payoutId",
          "commissionRuleId",
          "commissionRateChangeId",
          "identityEntitlementId",
          "billingEntitlementId",
          "visibilityReadModelId",
          "sourcePaymentId",
          "providerAccountRef",
          "providerPaymentIntentId",
          "providerPayoutId",
          "paymentAmount",
          "netPaymentAmount",
          "payoutAmount",
          "commissionRate",
          "currency",
          "visibilityScope",
          "requiredPermissionKey",
        ],
        findings,
      );
    }
    if (financeChecks["affiliatePayouts"] !== undefined) {
      validateObjectArray(
        financeChecks["affiliatePayouts"],
        "expected-target.json.financeChecks.affiliatePayouts",
        [
          "organizationId",
          "affiliateResourceId",
          "providerAccountId",
          "payoutSettingsId",
          "payoutId",
          "identityEntitlementId",
          "billingEntitlementId",
          "visibilityReadModelId",
          "providerAccountRef",
          "providerPayoutId",
          "payoutAmount",
          "currency",
          "visibilityScope",
          "requiredPermissionKey",
        ],
        findings,
      );
    }
    if (financeChecks["forbiddenVisibilityKeys"] !== undefined) {
      validateStringArray(
        financeChecks["forbiddenVisibilityKeys"],
        "expected-target.json.financeChecks.forbiddenVisibilityKeys",
        findings,
      );
    }
  }

  const pmsOperationsChecks = expected["pmsOperationsChecks"];
  if (isRecord(pmsOperationsChecks)) {
    validateKnownKeys(
      pmsOperationsChecks,
      PMS_OPERATIONS_CHECK_KEYS,
      "expected-target.json.pmsOperationsChecks",
      findings,
    );
    validateObjectArray(
      pmsOperationsChecks["properties"],
      "expected-target.json.pmsOperationsChecks.properties",
      [
        "propertyId",
        "organizationId",
        "pmsHotelResourceId",
        "roomTypeId",
        "roomId",
        "ratePlanId",
        "rateRuleId",
        "inventoryDate",
        "inventoryStatus",
        "roomBlockId",
        "guestBookingId",
        "assignmentId",
        "checkinRecordId",
        "checkoutChargeId",
        "checkoutRecordId",
        "privateNoteId",
        "messageThreadId",
        "messageId",
        "messageAttachmentId",
        "channelConnectionId",
        "channelRoomTypeMappingId",
        "channelRatePlanMappingId",
        "channelBookingMappingId",
        "bookingSyncStatusId",
        "sourceRoomTypeId",
        "sourceRoomId",
        "ratePlanCode",
        "publicBookingReference",
        "assignmentStatus",
        "roomNumber",
        "channel",
        "externalBookingId",
        "externalRoomTypeId",
        "externalRatePlanId",
      ],
      findings,
      [],
      [
        "inventoryTotalCount",
        "inventoryAssignedCount",
        "inventoryBlockedCount",
        "inventoryAvailableCount",
        "messageCount",
        "attachmentCount",
        "privateNoteCount",
        "checkoutChargeCount",
        "syncStatusCount",
      ],
    );
    if (pmsOperationsChecks["forbiddenOperationalSummaryKeys"] !== undefined) {
      validateStringArray(
        pmsOperationsChecks["forbiddenOperationalSummaryKeys"],
        "expected-target.json.pmsOperationsChecks.forbiddenOperationalSummaryKeys",
        findings,
      );
    }
  }

  const marketplaceChecks = expected["marketplaceChecks"];
  if (isRecord(marketplaceChecks)) {
    validateKnownKeys(
      marketplaceChecks,
      MARKETPLACE_CHECK_KEYS,
      "expected-target.json.marketplaceChecks",
      findings,
    );
    validateObjectArray(
      marketplaceChecks["slices"],
      "expected-target.json.marketplaceChecks.slices",
      MARKETPLACE_SLICE_STRING_FIELDS,
      findings,
      ["compensationType"],
      MARKETPLACE_SLICE_INTEGER_FIELDS,
    );
    if (marketplaceChecks["forbiddenPublicReadModelValues"] !== undefined) {
      validateStringArray(
        marketplaceChecks["forbiddenPublicReadModelValues"],
        "expected-target.json.marketplaceChecks.forbiddenPublicReadModelValues",
        findings,
      );
    }
  }

  const distributionBookabilityChecks = expected["distributionBookabilityChecks"];
  if (isRecord(distributionBookabilityChecks)) {
    validateKnownKeys(
      distributionBookabilityChecks,
      DISTRIBUTION_BOOKABILITY_CHECK_KEYS,
      "expected-target.json.distributionBookabilityChecks",
      findings,
    );
    validateObjectArray(
      distributionBookabilityChecks["properties"],
      "expected-target.json.distributionBookabilityChecks.properties",
      [
        "propertyId",
        "organizationId",
        "ownerUserId",
        "bookingHotelResourceId",
        "pmsHotelResourceId",
        "providerAccountId",
        "providerAccountRef",
        "quoteSessionId",
        "checkoutContextId",
        "availableRoomOfferSnapshotId",
        "soldOutRoomOfferSnapshotId",
        "roomTypeId",
        "ratePlanId",
        "deepLinkContextId",
        "activeApiClientId",
        "revokedApiClientId",
        "profileUsageEventId",
        "quoteUsageEventId",
        "deepLinkUsageEventId",
        "publicId",
        "canonicalSlug",
        "canonicalUrl",
        "bookingBaseUrl",
        "timezone",
        "defaultLocale",
        "defaultCurrency",
        "publicQuoteReference",
        "quoteHash",
        "deepLinkUrl",
        "contextTokenHash",
        "activePublicClientId",
        "revokedPublicClientId",
        "availableOfferKey",
        "soldOutOfferKey",
        "checkIn",
        "checkOut",
        "availableStayDate",
        "soldOutStayDate",
        "totalAmount",
      ],
      findings,
      [],
      ["adults", "children", "rooms", "availableRooms"],
    );
    if (distributionBookabilityChecks["forbiddenPublicOutputValues"] !== undefined) {
      validateStringArray(
        distributionBookabilityChecks["forbiddenPublicOutputValues"],
        "expected-target.json.distributionBookabilityChecks.forbiddenPublicOutputValues",
        findings,
      );
    }
  }

  const platformMediaChecks = expected["platformMediaChecks"];
  if (isRecord(platformMediaChecks)) {
    validateKnownKeys(
      platformMediaChecks,
      PLATFORM_MEDIA_CHECK_KEYS,
      "expected-target.json.platformMediaChecks",
      findings,
    );
    validateNonNegativeIntegerObject(
      platformMediaChecks["legacyUrlInventory"],
      "expected-target.json.platformMediaChecks.legacyUrlInventory",
      PLATFORM_MEDIA_INVENTORY_KEYS,
      findings,
    );
    validateStringArray(
      platformMediaChecks["requiredPurposes"],
      "expected-target.json.platformMediaChecks.requiredPurposes",
      findings,
    );
    validateStringArray(
      platformMediaChecks["requiredPublicVariants"],
      "expected-target.json.platformMediaChecks.requiredPublicVariants",
      findings,
    );
    if (platformMediaChecks["forbiddenPublicValues"] !== undefined) {
      validateStringArray(
        platformMediaChecks["forbiddenPublicValues"],
        "expected-target.json.platformMediaChecks.forbiddenPublicValues",
        findings,
      );
    }
  }

  const mediaUrlMigrationChecks = expected["mediaUrlMigrationChecks"];
  if (isRecord(mediaUrlMigrationChecks)) {
    validateKnownKeys(
      mediaUrlMigrationChecks,
      MEDIA_URL_MIGRATION_CHECK_KEYS,
      "expected-target.json.mediaUrlMigrationChecks",
      findings,
    );
    if (mediaUrlMigrationChecks["bookingPropertyMedia"] !== undefined) {
      validateObjectArray(
        mediaUrlMigrationChecks["bookingPropertyMedia"],
        "expected-target.json.mediaUrlMigrationChecks.bookingPropertyMedia",
        MEDIA_URL_BOOKING_PROPERTY_MEDIA_STRING_FIELDS,
        findings,
      );
    }
    if (mediaUrlMigrationChecks["propertyPublicProfiles"] !== undefined) {
      const propertyPublicProfiles = mediaUrlMigrationChecks["propertyPublicProfiles"];
      validateObjectArray(
        propertyPublicProfiles,
        "expected-target.json.mediaUrlMigrationChecks.propertyPublicProfiles",
        ["propertyId"],
        findings,
      );
      if (Array.isArray(propertyPublicProfiles)) {
        propertyPublicProfiles.forEach((profile, index) => {
          if (!isRecord(profile)) return;
          for (const field of ["mediaObjectIds", "urls", "forbiddenUrls"]) {
            validateStringArray(
              profile[field],
              `expected-target.json.mediaUrlMigrationChecks.propertyPublicProfiles[${index}].${field}`,
              findings,
            );
          }
        });
      }
    }
    if (mediaUrlMigrationChecks["forbiddenPublicReferenceValues"] !== undefined) {
      validateStringArray(
        mediaUrlMigrationChecks["forbiddenPublicReferenceValues"],
        "expected-target.json.mediaUrlMigrationChecks.forbiddenPublicReferenceValues",
        findings,
      );
    }
  }

  return findings.every((finding) => finding.code !== "INVALID_FIXTURE_CONFIG");
}

export async function checkRowCounts(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  for (const [tableRef, expectedCount] of Object.entries(expected.counts)) {
    const ref = parseTableRef(tableRef, findings);
    if (!ref) continue;

    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM "${ref.schema}"."${ref.table}"`,
    );
    const actual = parseInt(result.rows[0].count, 10);
    if (actual !== expectedCount) {
      findings.push({
        severity: "fail",
        code: "ROW_COUNT_MISMATCH",
        owner: "Parity harness",
        targetObject: tableRef,
        message: `Row count mismatch for ${tableRef}`,
        expected: String(expectedCount),
        actual: String(actual),
        suggestedAction: "Check fixture source rows and transform logic.",
      });
    }
  }
}

export async function checkIdStability(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  for (const [tableRef, ids] of Object.entries(expected.idStability)) {
    const ref = parseTableRef(tableRef, findings);
    if (!ref) continue;

    for (const id of ids) {
      const result = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM "${ref.schema}"."${ref.table}" WHERE id = $1) AS exists`,
        [id],
      );
      if (!result.rows[0].exists) {
        findings.push({
          severity: "fail",
          code: "ID_STABILITY_VIOLATION",
          owner: "Parity harness",
          targetObject: tableRef,
          message: `Source ID ${id} not found in ${tableRef} — ID was not preserved`,
          expected: `Row with id = ${id}`,
          actual: "Row not found",
          suggestedAction: "Verify the ETL transform preserves source primary key values.",
        });
      }
    }
  }
}
