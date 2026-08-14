import {
  PLATFORM_PROPERTY_LIFECYCLE_CONTRACT_VERSION,
  type PlatformPropertyLifecycleResult,
  type PlatformPropertyProvisionRequest,
} from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import type { SharedHotelSetupStatusRepository } from "../routes/sharedHotelSetupStatus.js";
import type { PlatformPropertyLifecycleAudit } from "./platformPropertyLifecycleCommandRepository.js";

export type PlatformPropertyProvisioningRepository = {
  provision(
    input: PlatformPropertyProvisionRequest & {
      idempotencyKey: string;
      audit: PlatformPropertyLifecycleAudit;
    },
  ): Promise<PlatformPropertyLifecycleResult>;
  close(): Promise<void>;
};

export class PlatformPropertyProvisioningError extends Error {
  constructor(readonly code: "account_not_found" | "account_organization_ambiguous") {
    super(code);
  }
}

type ProvisioningPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

export function createPgPlatformPropertyProvisioningRepository(config: {
  connectionString?: string;
  pool?: ProvisioningPool;
  setupRepository: SharedHotelSetupStatusRepository;
}): PlatformPropertyProvisioningRepository {
  if (!config.pool && !config.connectionString?.trim()) {
    throw new Error("Platform property provisioning connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString });
  return {
    async provision(input) {
      const organizations = await pool.query<{ organizationId: string }>(
        `SELECT organization.id::text AS "organizationId"
         FROM identity.users account
         JOIN identity.organization_memberships membership
           ON membership.user_id = account.id AND membership.status = 'active'
         JOIN identity.organizations organization
           ON organization.id = membership.organization_id
          AND organization.kind = 'hotel_group' AND organization.status = 'active'
         WHERE account.id = $1::uuid AND account.status = 'active'
         ORDER BY organization.id`,
        [input.accountUserId],
      );
      if (organizations.rows.length === 0) {
        throw new PlatformPropertyProvisioningError("account_not_found");
      }
      if (organizations.rows.length !== 1) {
        throw new PlatformPropertyProvisioningError("account_organization_ambiguous");
      }
      const organizationId = organizations.rows[0]!.organizationId;
      const profile = await config.setupRepository.createPropertyProfile({
        organizationId,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.audit.correlationId,
        profile: input.profile,
        audit: {
          actorUserId: input.audit.actorUserId,
          requestId: input.audit.requestId,
          receivedAt: input.audit.requestedAt,
          reason: input.reason,
        },
        targetAccountUserId: input.accountUserId,
        provisioningReference: input.provisioningReference,
      });
      const lifecycle = await pool.query<{
        lifecycleStatus: PlatformPropertyLifecycleResult["lifecycleStatus"];
        lifecycleRevision: number | string;
      }>(
        `SELECT lifecycle_status AS "lifecycleStatus",
                lifecycle_revision AS "lifecycleRevision"
         FROM hotel_catalog.properties WHERE id = $1::uuid`,
        [profile.propertyId],
      );
      const state = lifecycle.rows[0];
      if (!state) throw new Error("Provisioned property lifecycle state was not found");
      const lifecycleRevision = Number(state.lifecycleRevision);
      if (!Number.isSafeInteger(lifecycleRevision) || lifecycleRevision < 1) {
        throw new Error("Provisioned property lifecycle revision was invalid");
      }
      return {
        contractVersion: PLATFORM_PROPERTY_LIFECYCLE_CONTRACT_VERSION,
        propertyId: profile.propertyId,
        lifecycleStatus: state.lifecycleStatus,
        lifecycleRevision,
      };
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}
