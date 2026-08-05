import {
  type JsonValue,
  type PropertySetupSession,
  type PropertySetupStepDraft,
  type PropertySetupStepId,
} from "@vayada/domain-hotels";
import pg from "pg";

type SessionRow = {
  contractVersion: PropertySetupSession["contractVersion"];
  sessionId: string;
  organizationId: string;
  propertyId: string;
  selectedTracks: PropertySetupSession["selectedTracks"];
  trackRevision: number;
  revision: number;
  resumeStepId: PropertySetupStepId | null;
  completedStepIds: PropertySetupStepId[];
  retentionExpiresAt: Date | string;
};

type DraftRow = {
  stepId: PropertySetupStepId;
  payload: Record<string, JsonValue>;
  dirtyFields: string[];
  baseRevisions: Record<string, string>;
  piiClassification: PropertySetupStepDraft["piiClassification"];
  retentionExpiresAt: Date | string;
  revision: number;
  updatedAt: Date | string;
};

export type PropertySetupDraftScope = {
  organizationId: string;
  propertyId: string;
  actorUserId: string;
  /** Step IDs allowed by the caller's route-policy and entitlement checks. */
  authorizedStepIds: readonly PropertySetupStepId[];
};

/**
 * Reads draft state only after re-proving the active principal, membership, and
 * canonical property link. Callers must still enforce the route permission and
 * product entitlement before invoking this repository and pass only the
 * resulting authorized step IDs.
 *
 * Stored setup rows are never treated as authorization evidence.
 */
export function createPgPropertySetupDraftRepository(config: {
  connectionString: string;
  max?: number;
  now?: () => Date;
}) {
  if (!config.connectionString.trim()) {
    throw new Error("Property setup draft repository connectionString must not be empty");
  }
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });
  const now = config.now ?? (() => new Date());

  return {
    async getActiveSession(scope: PropertySetupDraftScope): Promise<PropertySetupSession | null> {
      const client = await pool.connect();
      const readAt = now();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const session = await client.query<SessionRow>(
          `SELECT
             setup.contract_version AS "contractVersion",
             setup.id::text AS "sessionId",
             setup.organization_id::text AS "organizationId",
             setup.property_id::text AS "propertyId",
             setup.selected_tracks AS "selectedTracks",
             setup.track_revision AS "trackRevision",
             setup.revision,
             setup.resume_step_id AS "resumeStepId",
             setup.completed_step_ids AS "completedStepIds",
             setup.retention_expires_at AS "retentionExpiresAt"
           FROM hotel_catalog.property_setup_sessions setup
           JOIN identity.organizations organization
             ON organization.id = setup.organization_id
            AND organization.kind = 'hotel_group'
            AND organization.status = 'active'
           JOIN identity.users actor
             ON actor.id = $3::uuid
            AND actor.status = 'active'
           WHERE setup.organization_id = $1::uuid
             AND setup.property_id = $2::uuid
             AND setup.status = 'active'
             AND setup.retention_expires_at > $4::timestamptz
             AND EXISTS (
               SELECT 1
               FROM identity.organization_memberships membership
               WHERE membership.organization_id = setup.organization_id
                 AND membership.user_id = actor.id
                 AND membership.status = 'active'
             )
             AND EXISTS (
               SELECT 1
               FROM identity.organization_resource_links property_link
               WHERE property_link.organization_id = setup.organization_id
                 AND property_link.product = 'hotel_catalog'
                 AND property_link.resource_type = 'property'
                 AND property_link.resource_id = setup.property_id::text
                 AND property_link.relationship IN ('owner', 'operator')
                 AND property_link.status = 'active'
             )
           LIMIT 1`,
          [scope.organizationId, scope.propertyId, scope.actorUserId, readAt.toISOString()],
        );
        const row = session.rows[0];
        if (!row) {
          await client.query("COMMIT");
          return null;
        }

        // The stored session tracks preserve historical state, but they are not
        // the current route. The caller has already intersected the current
        // selected tracks with actor permissions, so those IDs control what is
        // visible now and allow retained drafts to reappear after restoration.
        const visibleStepIds = [...new Set(scope.authorizedStepIds)];
        const drafts = await client.query<DraftRow>(
          `SELECT
             draft.step_id AS "stepId",
             draft.payload,
             draft.dirty_fields AS "dirtyFields",
             draft.base_revisions AS "baseRevisions",
             draft.pii_classification AS "piiClassification",
             draft.retention_expires_at AS "retentionExpiresAt",
             draft.revision,
             draft.updated_at AS "updatedAt"
           FROM hotel_catalog.property_setup_step_drafts draft
           WHERE draft.session_id = $1::uuid
             AND draft.retention_expires_at > $2::timestamptz
             AND draft.step_id = ANY($3::text[])`,
          [row.sessionId, readAt.toISOString(), visibleStepIds],
        );
        await client.query("COMMIT");
        return toSession(row, drafts.rows, visibleStepIds);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}

export type PropertySetupDraftRepository = ReturnType<typeof createPgPropertySetupDraftRepository>;

function toSession(
  row: SessionRow,
  drafts: DraftRow[],
  visibleStepIds: readonly PropertySetupStepId[],
): PropertySetupSession {
  return {
    contractVersion: row.contractVersion,
    sessionId: row.sessionId,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    selectedTracks: row.selectedTracks,
    trackRevision: row.trackRevision,
    revision: row.revision,
    resumeStepId:
      row.resumeStepId && visibleStepIds.includes(row.resumeStepId) ? row.resumeStepId : null,
    completedStepIds: row.completedStepIds.filter((stepId) => visibleStepIds.includes(stepId)),
    drafts: drafts
      .sort(
        (left, right) => visibleStepIds.indexOf(left.stepId) - visibleStepIds.indexOf(right.stepId),
      )
      .map(
        (draft) =>
          ({
            ...draft,
            retentionExpiresAt: toIso(draft.retentionExpiresAt),
            updatedAt: toIso(draft.updatedAt),
          }) as PropertySetupStepDraft,
      ),
    retentionExpiresAt: toIso(row.retentionExpiresAt),
  };
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}
