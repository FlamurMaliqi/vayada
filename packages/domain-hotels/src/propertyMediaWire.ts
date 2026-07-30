import {
  parseAssignPropertyLogoRequest,
  parseReplacePropertyPresentationMediaRequest,
  type PropertyMediaCommandError,
  type PropertyMediaCommandResponse,
} from "./propertyMedia.js";

export function parsePropertyMediaCommandResponse(
  value: unknown,
): PropertyMediaCommandResponse | null {
  if (
    !isExactDataRecord(value, [
      "outcome",
      "profileRevision",
      "logoAssignment",
      "presentationAssignments",
    ]) ||
    !["updated", "idempotent_replay"].includes(value["outcome"] as string) ||
    !isPositiveRevision(value["profileRevision"]) ||
    !isDensePlainArray(value["presentationAssignments"])
  ) {
    return null;
  }
  const revision = value["profileRevision"];
  const logo = parseAssignPropertyLogoRequest({
    expectedProfileRevision: revision,
    assignment: value["logoAssignment"],
  });
  const presentation = parseReplacePropertyPresentationMediaRequest({
    expectedProfileRevision: revision,
    assignments: value["presentationAssignments"],
  });
  if (!logo || !presentation) return null;
  return Object.freeze({
    outcome: value["outcome"] as PropertyMediaCommandResponse["outcome"],
    profileRevision: revision as number,
    logoAssignment: logo.assignment,
    presentationAssignments: presentation.assignments,
  });
}

export function parsePropertyMediaCommandError(value: unknown): PropertyMediaCommandError | null {
  if (!isPlainDataRecord(value) || typeof value["code"] !== "string") return null;
  if (value["code"] === "profile_revision_conflict") {
    return isExactDataRecord(value, ["code", "currentRevision"]) &&
      isPositiveRevision(value["currentRevision"])
      ? Object.freeze({
          code: "profile_revision_conflict",
          currentRevision: value["currentRevision"] as number,
        })
      : null;
  }
  if (["idempotency_key_conflict", "command_in_progress"].includes(value["code"])) {
    return isExactDataRecord(value, ["code"])
      ? Object.freeze({
          code: value["code"] as "idempotency_key_conflict" | "command_in_progress",
        })
      : null;
  }
  if (
    !["media_not_found", "media_not_authorized", "media_not_ready"].includes(value["code"]) ||
    !isExactDataRecord(value, ["code", "mediaObjectIds"]) ||
    !isDensePlainArray(value["mediaObjectIds"]) ||
    value["mediaObjectIds"].length === 0 ||
    !value["mediaObjectIds"].every(isUuid) ||
    new Set(value["mediaObjectIds"].map((id) => id.toLowerCase())).size !==
      value["mediaObjectIds"].length
  ) {
    return null;
  }
  const mediaObjectIds = Object.freeze(
    value["mediaObjectIds"].map((id) => id.toLowerCase()),
  ) as unknown as string[];
  return Object.freeze({
    code: value["code"] as "media_not_found" | "media_not_authorized" | "media_not_ready",
    mediaObjectIds,
  });
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function isExactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isPlainDataRecord(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isDensePlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
  return Array.from({ length: value.length }, (_, index) => String(index)).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isPositiveRevision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647
  );
}
