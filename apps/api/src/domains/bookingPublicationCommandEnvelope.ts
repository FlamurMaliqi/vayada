import { createHash } from "node:crypto";

import {
  createProductReadinessResult,
  type ProductReadinessEvaluation,
} from "@vayada/domain-hotels";
import type {
  BookingPublicationOperation,
  BookingPublicationRequestError,
  BookingPublicationRequestResult,
  RequestBookingPublicationCommand,
} from "@vayada/domain-booking";

export type BookingPublicationOperationRow = {
  operationId: string;
  propertyId: string;
  status: BookingPublicationOperation["status"];
  expectedActiveContentRevisionId: string | null;
  resultContentRevisionId: string | null;
  failureCode: string | null;
  requestedAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
};

/** Fingerprints logical readiness identity, not audit metadata or evaluation time. */
export function bookingPublicationRequestFingerprint(
  command: RequestBookingPublicationCommand,
): string {
  const readiness = command.readiness;
  return sha256(
    JSON.stringify({
      organizationId: command.organizationId,
      propertyId: command.propertyId,
      expectedActiveContentRevisionId: command.expectedActiveContentRevisionId,
      readiness: {
        contractVersion: readiness.contractVersion,
        product: readiness.product,
        propertyId: readiness.propertyId,
        status: readiness.status,
        sourceManifest: readiness.sourceManifest,
        sourceManifestHash: readiness.sourceManifestHash,
        readinessHash: readiness.readinessHash,
      },
    }),
  );
}

export async function hasValidBookingReadinessEvidence(
  command: RequestBookingPublicationCommand,
): Promise<boolean> {
  const readiness = command.readiness;
  if (
    readiness.outcome !== "evaluated" ||
    readiness.product !== "booking" ||
    readiness.status !== "ready" ||
    readiness.propertyId !== command.propertyId
  ) {
    return false;
  }
  try {
    const { outcome: _, sourceManifestHash: __, readinessHash: ___, ...evaluation } = readiness;
    const verified = await createProductReadinessResult(evaluation as ProductReadinessEvaluation);
    return (
      verified.sourceManifestHash === readiness.sourceManifestHash &&
      verified.readinessHash === readiness.readinessHash
    );
  } catch {
    return false;
  }
}

export function operationProjection(
  row: BookingPublicationOperationRow,
): BookingPublicationOperation {
  return {
    operationId: row.operationId,
    propertyId: row.propertyId,
    status: row.status,
    expectedActiveContentRevisionId: row.expectedActiveContentRevisionId,
    resultContentRevisionId: row.resultContentRevisionId,
    failureCode: row.failureCode,
    requestedAt: iso(row.requestedAt),
    updatedAt: iso(row.updatedAt),
    completedAt: row.completedAt ? iso(row.completedAt) : null,
  };
}

export function parseStoredBookingPublicationResult(
  value: unknown,
): BookingPublicationRequestResult | null {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return null;
  if (value["ok"] === true) {
    const operation = value["operation"];
    return isOperation(operation) ? { ok: true, operation: operationProjection(operation) } : null;
  }
  const error = value["error"];
  return isError(error) ? { ok: false, error: errorProjection(error) } : null;
}

export function parseBookingPublicationIdempotencyMetadata(
  value: unknown,
): BookingPublicationRequestResult | null {
  return isRecord(value) ? parseStoredBookingPublicationResult(value["result"]) : null;
}

export function bookingPublicationResponseBody(result: BookingPublicationRequestResult) {
  return result.ok ? result.operation : result.error;
}

export function bookingPublicationResponseStatus(
  result: BookingPublicationRequestResult,
): 202 | 409 {
  return result.ok ? 202 : 409;
}

export function bookingPublicationFailure(
  error: BookingPublicationRequestError,
): BookingPublicationRequestResult {
  return { ok: false, error };
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isOperation(value: unknown): value is BookingPublicationOperation {
  if (!isRecord(value)) return false;
  return (
    isUuid(value["operationId"]) &&
    isUuid(value["propertyId"]) &&
    ["pending", "succeeded", "failed", "unknown"].includes(String(value["status"])) &&
    nullableUuid(value["expectedActiveContentRevisionId"]) &&
    nullableUuid(value["resultContentRevisionId"]) &&
    (value["failureCode"] === null || typeof value["failureCode"] === "string") &&
    isIso(value["requestedAt"]) &&
    isIso(value["updatedAt"]) &&
    (value["completedAt"] === null || isIso(value["completedAt"]))
  );
}

function isError(value: unknown): value is BookingPublicationRequestError {
  if (!isRecord(value)) return false;
  const codes = [
    "active_content_revision_conflict",
    "command_in_progress",
    "idempotency_key_conflict",
    "invalid_readiness_evidence",
    "publication_in_progress",
    "setup_scope_unavailable",
  ];
  return (
    codes.includes(String(value["code"])) &&
    (value["currentActiveContentRevisionId"] === undefined ||
      nullableUuid(value["currentActiveContentRevisionId"]))
  );
}

function errorProjection(error: BookingPublicationRequestError): BookingPublicationRequestError {
  return error.code === "active_content_revision_conflict"
    ? {
        code: error.code,
        currentActiveContentRevisionId: error.currentActiveContentRevisionId,
      }
    : { code: error.code };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function nullableUuid(value: unknown): boolean {
  return value === null || isUuid(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
