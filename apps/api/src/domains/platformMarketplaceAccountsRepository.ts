import pg from "pg";
import type { PlatformMarketplaceAccount } from "@vayada/domain-hotels";
import type { HotelSetupTrackCommandRepository } from "./hotelSetupTrackCommandRepository.js";

export function createPgPlatformMarketplaceAccountsRepository(config: {
  connectionString: string;
  tracks: Pick<HotelSetupTrackCommandRepository, "getTrackStatus">;
}) {
  const pool = new pg.Pool({ connectionString: config.connectionString });
  return {
    async list(accountUserId: string): Promise<PlatformMarketplaceAccount[]> {
      const result = await pool.query<Omit<PlatformMarketplaceAccount, "setup">>(
        `SELECT organization.id::text AS "organizationId", organization.name AS "displayName",
           COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
             'propertyId', property.id::text, 'displayName', property.display_name
           )) FILTER (WHERE property.id IS NOT NULL), '[]'::jsonb) AS properties
         FROM identity.users account
         JOIN identity.organization_memberships membership
           ON membership.user_id = account.id AND membership.status = 'active'
         JOIN identity.organizations organization ON organization.id = membership.organization_id
           AND organization.kind = 'hotel_group' AND organization.status = 'active'
         LEFT JOIN identity.organization_resource_links link ON link.organization_id = organization.id
           AND link.product = 'hotel_catalog' AND link.resource_type = 'property'
           AND link.relationship IN ('owner', 'operator') AND link.status = 'active'
         LEFT JOIN hotel_catalog.properties property ON property.id::text = link.resource_id
           AND property.lifecycle_status NOT IN ('suspended', 'retired')
         WHERE account.id::text = $1 AND account.status = 'active'
         GROUP BY organization.id ORDER BY organization.name, organization.id`,
        [accountUserId],
      );
      return Promise.all(
        result.rows.map(async (account) => ({
          ...account,
          setup: await config.tracks.getTrackStatus({ organizationId: account.organizationId }),
        })),
      );
    },
    async close() {
      await pool.end();
    },
  };
}
export type PlatformMarketplaceAccountsRepository = ReturnType<
  typeof createPgPlatformMarketplaceAccountsRepository
>;
