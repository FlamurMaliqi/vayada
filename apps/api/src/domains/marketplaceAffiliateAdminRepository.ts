import type {
  MarketplaceAffiliateAdminRecord,
  MarketplaceAffiliateAdminRepository,
  MarketplaceAffiliateLifecycleStatus,
} from "@vayada/domain-marketplace";
import pg, { type QueryResultRow } from "pg";

type AffiliateRow = QueryResultRow & {
  id: string;
  affiliateId: string;
  propertyId: string;
  referralCode: string;
  displayName: string | null;
  contactEmail: string | null;
  socialMedia: string | null;
  affiliateType: "guest" | "creator";
  lifecycleStatus: MarketplaceAffiliateLifecycleStatus;
  applicationSource: "public_registration" | "collaboration" | "migration";
  appliedAt: Date | string;
  updatedAt: Date | string;
};

const AFFILIATE_SELECT = `SELECT
  affiliate.id::text AS id,
  affiliate.affiliate_id AS "affiliateId",
  affiliate.property_id::text AS "propertyId",
  affiliate.referral_code AS "referralCode",
  affiliate.display_name AS "displayName",
  affiliate.contact_email AS "contactEmail",
  affiliate.social_media AS "socialMedia",
  affiliate.affiliate_type AS "affiliateType",
  affiliate.lifecycle_status AS "lifecycleStatus",
  affiliate.application_source AS "applicationSource",
  affiliate.applied_at AS "appliedAt",
  affiliate.updated_at AS "updatedAt"
FROM marketplace.property_affiliates affiliate`;

export function createPgMarketplaceAffiliateAdminRepository(config: {
  connectionString: string;
  max?: number;
  pool?: Pick<pg.Pool, "query" | "end">;
}): MarketplaceAffiliateAdminRepository {
  if (!config.connectionString.trim()) throw new Error("Marketplace database URL is required");
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async getAffiliate(propertyId, affiliateId) {
      const result = await pool.query<AffiliateRow>(
        `${AFFILIATE_SELECT}
         WHERE affiliate.property_id = $1::uuid AND affiliate.affiliate_id = $2
         LIMIT 1`,
        [propertyId, affiliateId],
      );
      return result.rows[0] ? mapAffiliate(result.rows[0]) : null;
    },

    async close() {
      await pool.end();
    },
  };
}

function mapAffiliate(row: AffiliateRow): MarketplaceAffiliateAdminRecord {
  return {
    contractVersion: "marketplace-affiliate-admin.v1",
    affiliateId: row.affiliateId,
    propertyId: row.propertyId,
    referralCode: row.referralCode,
    displayName: row.displayName,
    contactEmail: row.contactEmail,
    socialMedia: row.socialMedia,
    affiliateType: row.affiliateType,
    lifecycleStatus: row.lifecycleStatus,
    applicationSource: row.applicationSource,
    appliedAt: new Date(row.appliedAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
