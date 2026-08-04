import {
  PROPERTY_SETUP_STEP_DEFINITIONS,
  isPropertySetupBaseRevisionManifest,
  type PropertySetupFieldId,
  type SavePropertySetupDraftRequest,
} from "./propertySetupDraft.js";
import { isPropertySetupDraftFieldValue } from "./propertySetupDraftFieldValidation.js";
import {
  snapshotPropertySetupDraftRequest,
  type PropertySetupDraftRequestError,
} from "./propertySetupDraftRequestSafety.js";

export type PropertySetupDraftRequestResult =
  | { ok: true; value: SavePropertySetupDraftRequest }
  | { ok: false; error: PropertySetupDraftRequestError };

const MAX_REVISION = 2_147_483_646;
const REQUEST_KEYS = [
  "stepId",
  "payload",
  "dirtyFields",
  "expectedBaseRevisions",
  "expectedTrackRevision",
  "expectedSessionRevision",
  "expectedDraftRevision",
] as const;
const FORBIDDEN_KEY_PARTS = [
  "password",
  "passphrase",
  "secret",
  "credential",
  "connectionstring",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "privatekey",
  "authorization",
  "token",
  "entitlement",
  "permission",
  "membership",
  "relationship",
  "role",
  "capability",
  "selectedtrack",
  "productselection",
  "accessgranted",
  "resourceaccess",
  "organizationaccess",
  "propertyaccess",
  "isadmin",
  "iban",
  "bic",
  "swift",
  "bank",
  "routing",
  "account",
  "cardnumber",
  "cvv",
  "cvc",
  "paymentdestination",
  "payout",
  "wallet",
  "providersigning",
] as const;
const ROOT_ENTITY_MAP_FIELDS = new Set<PropertySetupFieldId>([
  "room.name",
  "room.category",
  "room.max_occupancy",
  "room.max_adults",
  "room.max_children",
  "room.beds",
  "room.bedrooms",
  "room.bathrooms",
  "room.bathroom_type",
  "room.size",
  "room.description",
  "room.unit_count",
  "room.images",
  "room.amenities",
  "rate.base_nightly_rate",
  "rate.weekend_surcharge",
  "rate.occupancy_prices",
]);

export function parseSavePropertySetupDraftRequest(
  value: unknown,
): PropertySetupDraftRequestResult {
  const snapshotResult = snapshotPropertySetupDraftRequest(value);
  if (!snapshotResult.ok) return snapshotResult;
  const snapshot = snapshotResult.value;
  if (!isRecord(snapshot)) return invalidRequest();
  if (Object.keys(snapshot).some(isForbiddenKey)) return unsafePayload();
  if (!hasExactKeys(snapshot, REQUEST_KEYS)) return invalidRequest();

  const definition = PROPERTY_SETUP_STEP_DEFINITIONS.find(
    ({ stepId }) => stepId === snapshot["stepId"],
  );
  if (!definition) return invalidRequest();

  const payload = snapshot["payload"];
  const dirtyFields = snapshot["dirtyFields"];
  const baseRevisions = snapshot["expectedBaseRevisions"];
  const allowedFields = new Set<string>(definition.fields);
  if (!isRecord(payload)) return invalidRequest();
  for (const [field, fieldValue] of Object.entries(payload)) {
    if (isForbiddenKey(field)) return unsafePayload();
    if (!allowedFields.has(field)) return invalidRequest();
    if (containsForbiddenFieldKey(field as PropertySetupFieldId, fieldValue, [])) {
      return unsafePayload();
    }
    if (!isPropertySetupDraftFieldValue(field as PropertySetupFieldId, fieldValue)) {
      return invalidRequest();
    }
  }

  if (!isRecord(baseRevisions)) return invalidRequest();
  if (Object.keys(baseRevisions).some(isForbiddenKey)) return unsafePayload();
  if (
    !Array.isArray(dirtyFields) ||
    dirtyFields.length > definition.fields.length ||
    !dirtyFields.every(
      (field) =>
        typeof field === "string" && allowedFields.has(field) && Object.hasOwn(payload, field),
    ) ||
    new Set(dirtyFields).size !== dirtyFields.length ||
    !isPropertySetupBaseRevisionManifest(definition.stepId, baseRevisions) ||
    !isRevision(snapshot["expectedTrackRevision"]) ||
    !isRevision(snapshot["expectedSessionRevision"]) ||
    !isRevision(snapshot["expectedDraftRevision"])
  ) {
    return invalidRequest();
  }

  const dirtyFieldSet = new Set(dirtyFields);
  return {
    ok: true,
    value: {
      stepId: definition.stepId,
      payload: Object.fromEntries(
        definition.fields
          .filter((field) => Object.hasOwn(payload, field))
          .map((field) => [field, payload[field]]),
      ),
      dirtyFields: definition.fields.filter((field) => dirtyFieldSet.has(field)),
      expectedBaseRevisions: Object.fromEntries(
        definition.baseRevisionKeys.map((key) => [key, baseRevisions[key]]),
      ),
      expectedTrackRevision: snapshot["expectedTrackRevision"],
      expectedSessionRevision: snapshot["expectedSessionRevision"],
      expectedDraftRevision: snapshot["expectedDraftRevision"],
    } as SavePropertySetupDraftRequest,
  };
}

function containsForbiddenFieldKey(
  field: PropertySetupFieldId,
  value: unknown,
  path: readonly string[],
): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((nested) => containsForbiddenFieldKey(field, nested, [...path, "*"]));
  }
  const dynamicKeys =
    (ROOT_ENTITY_MAP_FIELDS.has(field) && path.length === 0) ||
    (field === "rate.seasonal_prices" && path.length <= 1) ||
    (field === "rate.initial_availability" && path.length === 1 && path[0] === "limits");
  return Object.entries(value).some(
    ([key, nested]) =>
      (!dynamicKeys && isForbiddenKey(key)) ||
      containsForbiddenFieldKey(field, nested, [...path, key]),
  );
}

function isForbiddenKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return FORBIDDEN_KEY_PARTS.some((forbidden) => normalized.includes(forbidden));
}

function isRevision(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_REVISION;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(): PropertySetupDraftRequestResult {
  return {
    ok: false,
    error: { code: "invalid_request", message: "The property setup draft request is invalid." },
  };
}

function unsafePayload(): PropertySetupDraftRequestResult {
  return {
    ok: false,
    error: {
      code: "unsafe_payload",
      message: "The property setup draft request contains disallowed sensitive data.",
    },
  };
}
