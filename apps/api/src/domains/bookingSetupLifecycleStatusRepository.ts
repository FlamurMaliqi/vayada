import { createHash } from "node:crypto";

import {
  BOOKING_PUBLICATION_FAILURE_CODES,
  BOOKING_PUBLICATION_OPERATION_STATUSES,
  type BookingPublicationFailureCode,
  type BookingPublicationOperationStatus,
} from "@vayada/domain-booking";
import pg from "pg";

import type {
  BookingSetupLifecyclePhase,
  BookingSetupLifecycleStatusPort,
} from "../platform/propertySetupReviewLifecycleState.js";
import {
  requirePropertySetupLifecycleAccess,
  type PropertySetupLifecycleQueryExecutor,
} from "./propertySetupLifecycleAuthorization.js";

export type BookingSetupLifecycleStatusRepository = BookingSetupLifecycleStatusPort & {
  close(): Promise<void>;
};

type BookingLifecycleRow = {
  operationId: string | null;
  attemptStatus: BookingPublicationOperationStatus | null;
  resultRevisionId: string | null;
  failureCode: BookingPublicationFailureCode | null;
  attemptUpdatedAt: Date | string | null;
  activeRevisionId: string | null;
  activatedAt: Date | string | null;
};

export function createPgBookingSetupLifecycleStatusRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PropertySetupLifecycleQueryExecutor & { end?(): Promise<void> };
}): BookingSetupLifecycleStatusRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Booking setup lifecycle connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    (new pg.Pool({ connectionString: config.connectionString, max: config.max }) as pg.Pool);

  return {
    async getBookingSetupLifecycleStatus(scope) {
      await requirePropertySetupLifecycleAccess(pool, scope, {
        product: "booking",
        permission: "booking.settings.read",
        resourceType: "booking_hotel",
        entitlementKey: "booking-engine",
      });
      const result = await pool.query<BookingLifecycleRow>(
        `SELECT attempt.id::text AS "operationId",
                attempt.status AS "attemptStatus",
                attempt.result_content_revision_id::text AS "resultRevisionId",
                attempt.failure_code AS "failureCode",
                attempt.updated_at AS "attemptUpdatedAt",
                active.content_revision_id::text AS "activeRevisionId",
                active.activated_at AS "activatedAt"
         FROM (SELECT 1) anchor
         LEFT JOIN LATERAL (
           SELECT publication.id, publication.status,
                  publication.result_content_revision_id,
                  publication.failure_code, publication.updated_at
           FROM booking.booking_publication_attempts publication
           WHERE publication.property_id = $1::uuid
             AND publication.organization_id = $2::uuid
           ORDER BY publication.requested_at DESC, publication.id DESC
           LIMIT 1
         ) attempt ON TRUE
         LEFT JOIN distribution.active_public_booking_revision active
           ON active.property_id = $1::uuid`,
        [scope.propertyId, scope.organizationId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Booking setup lifecycle snapshot is unavailable");
      assertBookingLifecycleRow(row);
      return Object.freeze({
        ...scope,
        product: "booking" as const,
        phase: bookingPhase(row),
        sourceRevision: lifecycleRevision("booking-review", row),
      });
    },
    async close() {
      if (ownsPool && pool.end) await pool.end();
    },
  };
}

function assertBookingLifecycleRow(row: BookingLifecycleRow): void {
  if (
    (row.attemptStatus !== null &&
      !BOOKING_PUBLICATION_OPERATION_STATUSES.includes(row.attemptStatus)) ||
    (row.failureCode !== null && !BOOKING_PUBLICATION_FAILURE_CODES.includes(row.failureCode))
  ) {
    throw new Error("Booking setup lifecycle status is malformed");
  }
  const hasAttempt = row.operationId !== null;
  if (
    hasAttempt !== (row.attemptStatus !== null) ||
    hasAttempt !== (row.attemptUpdatedAt !== null)
  ) {
    throw new Error("Booking setup lifecycle attempt is malformed");
  }
  const hasActive = row.activeRevisionId !== null;
  if (hasActive !== (row.activatedAt !== null)) {
    throw new Error("Booking setup lifecycle activation is malformed");
  }
  if (!hasAttempt && (row.failureCode !== null || row.resultRevisionId !== null)) {
    throw new Error("Booking setup lifecycle attempt is malformed");
  }
  switch (row.attemptStatus) {
    case null:
    case "pending":
      if (row.failureCode !== null || row.resultRevisionId !== null) {
        throw new Error("Pending Booking publication result is malformed");
      }
      break;
    case "unknown":
    case "failed":
      if (row.failureCode === null || row.resultRevisionId !== null) {
        throw new Error("Unsuccessful Booking publication result is malformed");
      }
      break;
    case "succeeded":
      if (
        row.failureCode !== null ||
        row.resultRevisionId === null ||
        row.activeRevisionId !== row.resultRevisionId
      ) {
        throw new Error("Successful Booking publication has no active result");
      }
      break;
  }
  timestamp(row.attemptUpdatedAt);
  timestamp(row.activatedAt);
}

function bookingPhase(row: BookingLifecycleRow): BookingSetupLifecyclePhase {
  if (row.attemptStatus === "pending") return "publishing";
  if (row.attemptStatus === "unknown") return "publication_unknown";
  if (row.attemptStatus === "failed") {
    return row.failureCode === "source_content_changed"
      ? "source_content_changed"
      : "publication_failed";
  }
  if (row.attemptStatus === "succeeded" || row.activeRevisionId) return "published";
  return "not_started";
}

function lifecycleRevision(prefix: string, row: BookingLifecycleRow): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        operationId: row.operationId,
        attemptStatus: row.attemptStatus,
        resultRevisionId: row.resultRevisionId,
        failureCode: row.failureCode,
        attemptUpdatedAt: timestamp(row.attemptUpdatedAt),
        activeRevisionId: row.activeRevisionId,
        activatedAt: timestamp(row.activatedAt),
      }),
    )
    .digest("hex");
  return `${prefix}:sha256:${digest}`;
}

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new Error("Lifecycle timestamp is malformed");
  return parsed.toISOString();
}
