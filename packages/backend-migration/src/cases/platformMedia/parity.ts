import type { ParityFinding, ParityHandlerContext } from "../../parityTypes.js";

const REQUIRED_PURPOSES = [
  "booking.header_logo",
  "property.hero_image",
  "property.gallery_image",
  "property.logo",
  "marketplace.offer.media",
  "marketplace.creator.profile_image",
  "marketplace.collaboration_chat.attachment",
  "pms.room_type.media",
  "pms.messaging.attachment",
  "pms.import.source_image",
];

const REQUIRED_PUBLIC_VARIANTS = ["original_safe", "large", "thumbnail", "blur_preview"];

function addPlatformMediaFinding(
  findings: ParityFinding[],
  code: string,
  targetObject: string,
  message: string,
  expected: string,
  actual: string,
  suggestedAction: string,
): void {
  findings.push({
    severity: "fail",
    code,
    owner: "Platform media",
    targetObject,
    message,
    expected,
    actual,
    suggestedAction,
  });
}

export async function checkPlatformMediaParity({
  client,
  expected,
  findings,
}: ParityHandlerContext): Promise<void> {
  const config = expected.platformMediaChecks;
  if (!config) {
    addPlatformMediaFinding(
      findings,
      "PLATFORM_MEDIA_EXPECTED_CONFIG_MISSING",
      "expected-target.json.platformMediaChecks",
      "Platform media fixture must document media migration parity requirements",
      "platformMediaChecks with legacy URL inventory, required purposes, variants, and leakage checks",
      "undefined",
      "Add platformMediaChecks to platform-media/expected-target.json.",
    );
    return;
  }

  const missingPurposes = REQUIRED_PURPOSES.filter(
    (purpose) => !config.requiredPurposes.includes(purpose),
  );
  if (missingPurposes.length > 0) {
    addPlatformMediaFinding(
      findings,
      "PLATFORM_MEDIA_REQUIRED_PURPOSE_MISSING",
      "expected-target.json.platformMediaChecks.requiredPurposes",
      "Platform media parity contract must enumerate every approved media purpose from the decision record",
      REQUIRED_PURPOSES.join(", "),
      `missing: ${missingPurposes.join(", ")}`,
      "Add the missing purpose values to the expected target contract.",
    );
  }

  const missingVariants = REQUIRED_PUBLIC_VARIANTS.filter(
    (variant) => !config.requiredPublicVariants.includes(variant),
  );
  if (missingVariants.length > 0) {
    addPlatformMediaFinding(
      findings,
      "PLATFORM_MEDIA_REQUIRED_PUBLIC_VARIANT_MISSING",
      "expected-target.json.platformMediaChecks.requiredPublicVariants",
      "Public image parity must require the generated public variant set",
      REQUIRED_PUBLIC_VARIANTS.join(", "),
      `missing: ${missingVariants.join(", ")}`,
      "Add the missing public variants to the expected target contract.",
    );
  }

  const { rows: inventoryRows } = await client.query<{
    source_url_count: string;
    copied_object_count: string;
    external_reference_count: string;
    unresolved_external_url_count: string;
    public_object_count: string;
    private_object_count: string;
  }>(`
    SELECT
      count(*) FILTER (WHERE source_url IS NOT NULL)::text AS source_url_count,
      count(*) FILTER (
        WHERE source_url IS NOT NULL AND storage_kind = 'vayada_managed'
      )::text AS copied_object_count,
      count(*) FILTER (WHERE storage_kind = 'external_reference')::text AS external_reference_count,
      count(*) FILTER (
        WHERE storage_kind = 'external_reference'
          AND lifecycle_status = 'external_reference'
      )::text AS unresolved_external_url_count,
      count(*) FILTER (WHERE visibility = 'public')::text AS public_object_count,
      count(*) FILTER (WHERE visibility = 'private')::text AS private_object_count
    FROM platform.media_objects
  `);
  const inventory = inventoryRows[0];
  const actualInventory = {
    sourceUrlCount: Number.parseInt(inventory.source_url_count, 10),
    copiedObjectCount: Number.parseInt(inventory.copied_object_count, 10),
    externalReferenceCount: Number.parseInt(inventory.external_reference_count, 10),
    unresolvedExternalUrlCount: Number.parseInt(inventory.unresolved_external_url_count, 10),
    publicObjectCount: Number.parseInt(inventory.public_object_count, 10),
    privateObjectCount: Number.parseInt(inventory.private_object_count, 10),
  };

  for (const [key, expectedCount] of Object.entries(config.legacyUrlInventory)) {
    const actualCount = actualInventory[key as keyof typeof actualInventory];
    if (actualCount === expectedCount) continue;

    addPlatformMediaFinding(
      findings,
      "PLATFORM_MEDIA_LEGACY_URL_INVENTORY_MISMATCH",
      `platform.media_objects.${key}`,
      "Legacy media URL inventory count does not match the expected migration classification",
      String(expectedCount),
      String(actualCount),
      "Check copied, external-reference, public/private classification in the media transform before cutover.",
    );
  }

  const { rows: missingVariantRows } = await client.query<{ media_object_id: string }>(
    `
      SELECT media.id::text AS media_object_id
      FROM platform.media_objects media
      WHERE media.visibility = 'public'
        AND media.lifecycle_status = 'active'
        AND media.purpose IN (
          'booking.header_logo',
          'property.hero_image',
          'property.gallery_image',
          'property.logo',
          'marketplace.offer.media',
          'marketplace.creator.profile_image',
          'pms.room_type.media'
        )
        AND EXISTS (
          SELECT 1
          FROM unnest($1::text[]) AS required(variant_name)
          WHERE NOT EXISTS (
            SELECT 1
            FROM platform.media_variants variant
            WHERE variant.media_object_id = media.id
              AND variant.visibility = 'public'
              AND variant.variant_name = required.variant_name
              AND variant.public_cdn_url IS NOT NULL
          )
        )
    `,
    [config.requiredPublicVariants],
  );
  if (missingVariantRows.length > 0) {
    addPlatformMediaFinding(
      findings,
      "PLATFORM_MEDIA_PUBLIC_VARIANTS_MISSING",
      "platform.media_variants",
      "Every active public image object must have the required public CDN variants before cutover",
      config.requiredPublicVariants.join(", "),
      missingVariantRows.map((row) => row.media_object_id).join(", "),
      "Generate or backfill required public variants for the listed media objects.",
    );
  }

  for (const forbiddenValue of config.forbiddenPublicValues ?? []) {
    const { rows } = await client.query<{ leaked: boolean }>(
      `
        SELECT EXISTS(
          SELECT 1
          FROM platform.media_objects media
          LEFT JOIN platform.media_variants variant
            ON variant.media_object_id = media.id
          WHERE media.visibility = 'public'
            AND (
              COALESCE(media.source_url, '') LIKE '%' || $1 || '%'
              OR COALESCE(media.storage_key, '') LIKE '%' || $1 || '%'
              OR COALESCE(variant.public_cdn_url, '') LIKE '%' || $1 || '%'
              OR COALESCE(variant.storage_key, '') LIKE '%' || $1 || '%'
            )
        ) AS leaked
      `,
      [forbiddenValue],
    );
    if (rows[0]?.leaked !== true) continue;

    addPlatformMediaFinding(
      findings,
      "PLATFORM_MEDIA_PUBLIC_PRIVATE_VALUE_LEAK",
      "platform.media_objects",
      "Public media registry rows or variants expose a value marked private by the fixture contract",
      "No forbidden value in public storage keys, source URLs, or CDN URLs",
      forbiddenValue,
      "Remove private storage keys, provider URLs, or sensitive values from public media/read-model outputs.",
    );
  }
}
