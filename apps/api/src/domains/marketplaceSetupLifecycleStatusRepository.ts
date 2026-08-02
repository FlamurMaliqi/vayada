import { createHash } from "node:crypto";

import {
  MARKETPLACE_ACTIVATION_STATUSES,
  MARKETPLACE_MODERATION_STATUSES,
  type MarketplaceActivationStatus,
  type MarketplaceModerationStatus,
} from "@vayada/domain-hotels";
import pg from "pg";

import type {
  MarketplaceSetupLifecyclePhase,
  MarketplaceSetupLifecycleStatusPort,
} from "../platform/propertySetupReviewLifecycleState.js";
import {
  requirePropertySetupLifecycleAccess,
  type PropertySetupLifecycleQueryExecutor,
} from "./propertySetupLifecycleAuthorization.js";

export type MarketplaceSetupLifecycleStatusRepository = MarketplaceSetupLifecycleStatusPort & {
  close(): Promise<void>;
};

type MarketplaceLifecycleRow = {
  submissionRevisionId: string | null;
  revisionNumber: number | null;
  moderationStatus: MarketplaceModerationStatus | null;
  moderationUpdatedAt: Date | string | null;
  activeRevisionId: string | null;
  activationStatus: MarketplaceActivationStatus | null;
  activationUpdatedAt: Date | string | null;
};

export function createPgMarketplaceSetupLifecycleStatusRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PropertySetupLifecycleQueryExecutor & { end?(): Promise<void> };
}): MarketplaceSetupLifecycleStatusRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Marketplace setup lifecycle connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    (new pg.Pool({ connectionString: config.connectionString, max: config.max }) as pg.Pool);

  return {
    async getMarketplaceSetupLifecycleStatus(scope) {
      await requirePropertySetupLifecycleAccess(pool, scope, {
        product: "marketplace",
        permission: "marketplace.collaboration.read",
        resourceType: "hotel_profile",
        entitlementKey: "marketplace-hotel-profile",
      });
      const result = await pool.query<MarketplaceLifecycleRow>(
        `SELECT latest.id::text AS "submissionRevisionId",
                latest.revision_number AS "revisionNumber",
                moderation.status AS "moderationStatus",
                moderation.updated_at AS "moderationUpdatedAt",
                active.submission_revision_id::text AS "activeRevisionId",
                active.activation_status AS "activationStatus",
                active.updated_at AS "activationUpdatedAt"
         FROM (SELECT 1) anchor
         LEFT JOIN LATERAL (
           SELECT revision.id, revision.revision_number
           FROM marketplace.hotel_submission_revisions revision
           WHERE revision.property_id = $1::uuid
             AND revision.organization_id = $2::uuid
           ORDER BY revision.revision_number DESC
           LIMIT 1
         ) latest ON TRUE
         LEFT JOIN marketplace.hotel_submission_moderation moderation
           ON moderation.submission_revision_id = latest.id
          AND moderation.property_id = $1::uuid
         LEFT JOIN marketplace.active_hotel_submission_revisions active
           ON active.property_id = $1::uuid`,
        [scope.propertyId, scope.organizationId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Marketplace setup lifecycle snapshot is unavailable");
      assertMarketplaceLifecycleRow(row);
      return Object.freeze({
        ...scope,
        product: "marketplace" as const,
        phase: marketplacePhase(row),
        sourceRevision: lifecycleRevision("marketplace-review", row),
      });
    },
    async close() {
      if (ownsPool && pool.end) await pool.end();
    },
  };
}

function assertMarketplaceLifecycleRow(row: MarketplaceLifecycleRow): void {
  if (
    (row.moderationStatus !== null &&
      !MARKETPLACE_MODERATION_STATUSES.includes(row.moderationStatus)) ||
    (row.activationStatus !== null &&
      !MARKETPLACE_ACTIVATION_STATUSES.includes(row.activationStatus))
  ) {
    throw new Error("Marketplace setup lifecycle status is malformed");
  }
  const hasSubmission = row.submissionRevisionId !== null;
  if (
    hasSubmission !== (row.revisionNumber !== null) ||
    hasSubmission !== (row.moderationStatus !== null) ||
    hasSubmission !== (row.moderationUpdatedAt !== null)
  ) {
    throw new Error("Marketplace setup lifecycle snapshot is malformed");
  }
  if (
    row.revisionNumber !== null &&
    (!Number.isSafeInteger(row.revisionNumber) || row.revisionNumber < 1)
  ) {
    throw new Error("Marketplace setup lifecycle revision is malformed");
  }
  const hasActivation = row.activeRevisionId !== null;
  if (
    hasActivation !== (row.activationStatus !== null) ||
    hasActivation !== (row.activationUpdatedAt !== null)
  ) {
    throw new Error("Marketplace setup lifecycle activation is malformed");
  }
  if (hasActivation && !hasSubmission) {
    throw new Error("Marketplace setup lifecycle snapshot has no submission revision");
  }
  if (
    row.activeRevisionId === row.submissionRevisionId &&
    row.activeRevisionId !== null &&
    row.moderationStatus !== "approved"
  ) {
    throw new Error("Active Marketplace submission is not approved");
  }
  timestamp(row.moderationUpdatedAt);
  timestamp(row.activationUpdatedAt);
}

function marketplacePhase(row: MarketplaceLifecycleRow): MarketplaceSetupLifecyclePhase {
  if (!row.submissionRevisionId) return "not_started";
  if (row.activeRevisionId === row.submissionRevisionId) {
    if (row.activationStatus === "active") return "published";
    if (row.activationStatus === "suspended") return "suspended";
    if (row.activationStatus === "deactivated") return "deactivated";
    throw new Error("Active Marketplace submission has no activation status");
  }
  if (row.moderationStatus === "pending") return "pending_review";
  return row.moderationStatus ?? "not_started";
}

function lifecycleRevision(prefix: string, row: MarketplaceLifecycleRow): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        submissionRevisionId: row.submissionRevisionId,
        revisionNumber: row.revisionNumber,
        moderationStatus: row.moderationStatus,
        moderationUpdatedAt: timestamp(row.moderationUpdatedAt),
        activeRevisionId: row.activeRevisionId,
        activationStatus: row.activationStatus,
        activationUpdatedAt: timestamp(row.activationUpdatedAt),
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
