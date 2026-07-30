import type { JsonValue } from "./propertySetupDraft.js";

export const PROPERTY_SETUP_DRAFT_MAX_REQUEST_BYTES = 65_536;
export const PROPERTY_SETUP_DRAFT_MAX_DEPTH = 20;
export const PROPERTY_SETUP_DRAFT_MAX_NODES = 10_000;

export type PropertySetupDraftRequestErrorCode =
  | "invalid_request"
  | "payload_too_large"
  | "payload_too_deep"
  | "unsafe_payload";

export type PropertySetupDraftRequestError = {
  code: PropertySetupDraftRequestErrorCode;
  message: string;
};

export type PropertySetupDraftSnapshotResult =
  | { ok: true; value: JsonValue }
  | { ok: false; error: PropertySetupDraftRequestError };

const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/,
  /\bwhsec_[A-Za-z0-9]{10,}\b/,
  /\bacct_[A-Za-z0-9]{10,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]){11,30}\b/i,
  /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i,
  /\bhttps?:\/\/[^\s?]+\?[^\s]*(?:x-amz-signature|x-goog-signature|signature|sig|token)=/i,
] as const;
const ERROR_MESSAGES = {
  invalid_request: "The property setup draft request is invalid.",
  payload_too_large: "The property setup draft request exceeds the allowed size.",
  payload_too_deep: "The property setup draft request exceeds the allowed nesting depth.",
  unsafe_payload: "The property setup draft request contains disallowed sensitive data.",
} as const satisfies Record<PropertySetupDraftRequestErrorCode, string>;

export function snapshotPropertySetupDraftRequest(
  value: unknown,
): PropertySetupDraftSnapshotResult {
  let serializationError: PropertySetupDraftRequestErrorCode | null = null;
  let serialized: string | undefined;
  let visitedNodes = 0;
  try {
    serialized = JSON.stringify(value, (_key, nested) => {
      visitedNodes += 1;
      if (visitedNodes > PROPERTY_SETUP_DRAFT_MAX_NODES) {
        serializationError = "payload_too_large";
        throw new Error("node limit");
      }
      if (
        nested === undefined ||
        typeof nested === "bigint" ||
        typeof nested === "function" ||
        typeof nested === "symbol" ||
        (typeof nested === "number" && !Number.isFinite(nested))
      ) {
        serializationError = "invalid_request";
        throw new Error("non-JSON value");
      }
      return nested;
    });
  } catch {
    return failure(serializationError ?? "invalid_request");
  }
  if (serialized === undefined) return failure("invalid_request");
  if (exceedsUtf8ByteLimit(serialized, PROPERTY_SETUP_DRAFT_MAX_REQUEST_BYTES)) {
    return failure("payload_too_large");
  }

  const snapshot = JSON.parse(serialized) as JsonValue;
  const inspectionError = inspectSnapshot(snapshot, 0);
  return inspectionError ? failure(inspectionError) : { ok: true, value: snapshot };
}

function inspectSnapshot(
  value: JsonValue,
  depth: number,
): PropertySetupDraftRequestErrorCode | null {
  if (depth > PROPERTY_SETUP_DRAFT_MAX_DEPTH) return "payload_too_deep";
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value)) ? "unsafe_payload" : null;
  }
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const nested of value) {
      const nestedError = inspectSnapshot(nested, depth + 1);
      if (nestedError) return nestedError;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (DANGEROUS_OBJECT_KEYS.has(key.toLowerCase())) return "unsafe_payload";
    const nestedError = inspectSnapshot(nested, depth + 1);
    if (nestedError) return nestedError;
  }
  return null;
}

function exceedsUtf8ByteLimit(value: string, maximum: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : 3;
    if (code >= 0xd800 && code <= 0xdbff) index += 1;
    if (bytes > maximum) return true;
  }
  return false;
}

function failure(code: PropertySetupDraftRequestErrorCode): PropertySetupDraftSnapshotResult {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code] } };
}
