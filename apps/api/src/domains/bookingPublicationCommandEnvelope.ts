import { createHash } from "node:crypto";

import {
  createProductReadinessResult,
  type ProductReadinessEvaluation,
} from "@vayada/domain-hotels";
import { BOOKING_PUBLICATION_FAILURE_CODES } from "@vayada/domain-booking";
import type {
  BookingPublicationFailureCode,
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
  failureCode: BookingPublicationFailureCode | null;
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
  expected: Readonly<{ propertyId: string; operationId: string | null }>,
): BookingPublicationRequestResult | null {
  if (!isRecord(value)) return null;
  const result = parseStoredBookingPublicationResult(value["result"]);
  if (!result) return null;
  if (!result.ok) return expected.operationId === null ? result : null;
  return expected.operationId !== null &&
    result.operation.propertyId === expected.propertyId &&
    result.operation.operationId === expected.operationId &&
    result.operation.status === "pending"
    ? result
    : null;
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
  if (
    !(
      isUuid(value["operationId"]) &&
      isUuid(value["propertyId"]) &&
      ["pending", "succeeded", "failed", "unknown"].includes(String(value["status"])) &&
      nullableUuid(value["expectedActiveContentRevisionId"]) &&
      nullableUuid(value["resultContentRevisionId"]) &&
      (value["failureCode"] === null ||
        BOOKING_PUBLICATION_FAILURE_CODES.includes(
          value["failureCode"] as BookingPublicationFailureCode,
        )) &&
      isIso(value["requestedAt"]) &&
      isIso(value["updatedAt"]) &&
      (value["completedAt"] === null || isIso(value["completedAt"]))
    )
  )
    return false;

  const status = value["status"];
  const resultRevision = value["resultContentRevisionId"];
  const failureCode = value["failureCode"];
  const completedAt = value["completedAt"];
  const requestedAt = Date.parse(value["requestedAt"] as string);
  const updatedAt = Date.parse(value["updatedAt"] as string);
  const completedTime = completedAt === null ? null : Date.parse(completedAt as string);
  if (updatedAt < requestedAt || (completedTime !== null && completedTime < updatedAt)) {
    return false;
  }
  if (status === "pending") {
    return resultRevision === null && failureCode === null && completedAt === null;
  }
  if (status === "unknown") {
    return resultRevision === null && failureCode !== null && completedAt === null;
  }
  if (status === "failed") {
    return resultRevision === null && failureCode !== null && completedAt !== null;
  }
  return resultRevision !== null && failureCode === null && completedAt !== null;
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
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
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
