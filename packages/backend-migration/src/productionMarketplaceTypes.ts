import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import type { ProductionMigrationSourceLink } from "./productionBookingTypes.js";
import type { LegacyMarketplacePreferenceDraftCandidate } from "@vayada/domain-marketplace";

export type MarketplaceTargetRecord = {
  targetProduct: "marketplace";
  targetTable: string;
  targetId: string;
  sourceDatabase: "marketplace";
  sourceTable: string;
  sourceId: string;
  sourceChecksum: string;
  sourceUpdatedAt: string;
  mutable: true;
  row: Record<string, unknown>;
};

export type ExistingMarketplaceTargetRecord = {
  targetProduct: string;
  targetTable: string;
  targetId: string;
  updatedAt: string;
  row: Record<string, unknown>;
};

export type MarketplacePropertyLink = {
  sourceId: string;
  propertyId: string;
  relationship: string;
  status: string;
  migrationRunId: string | null;
};

export type MarketplaceResourceLink = {
  organizationId: string;
  resourceType: string;
  resourceId: string;
  relationship: string;
  status: string;
};

export type MarketplacePublicProperty = {
  propertyId: string;
  publicId: string;
  displayName: string;
  canonicalSlug: string;
  location: Record<string, unknown>;
};

export type MarketplaceMediaReference = {
  mediaObjectId: string;
  sourceUrl: string;
  sourceTable: string;
  sourceRowId: string;
  sourceField: string | null;
  visibility: string;
  purpose: string;
  lifecycleStatus: string;
  publicApproved: boolean;
  publicUrl: string | null;
  resourceType: string | null;
  resourceId: string | null;
};

export type ProductionMarketplacePrerequisites = {
  propertyLinks: MarketplacePropertyLink[];
  resourceLinks: MarketplaceResourceLink[];
  userIds: string[];
  userNames: Array<{ id: string; name: string | null }>;
  publicProperties: MarketplacePublicProperty[];
  media: MarketplaceMediaReference[];
  hotelPreferences: Array<{ propertyId: string; revision: number }>;
};

export type ProductionMarketplaceTargetState = ProductionMarketplacePrerequisites & {
  records: ExistingMarketplaceTargetRecord[];
  provenance: ProductionMigrationSourceLink[];
  blockers?: IdentityMigrationBlocker[];
};

export type MarketplaceBuildContext = {
  sourceRunId: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionMarketplaceTargetState;
  blockers: IdentityMigrationBlocker[];
  rowsByTable: Map<string, IdentitySourceRow[]>;
  creatorById: Map<string, IdentitySourceRow>;
  hotelById: Map<string, IdentitySourceRow>;
  offerById: Map<string, IdentitySourceRow>;
  collaborationById: Map<string, IdentitySourceRow>;
  tripById: Map<string, IdentitySourceRow>;
  creatorOrganizationById: Map<string, string>;
  hotelOrganizationById: Map<string, string>;
  propertyByHotelId: Map<string, string>;
  users: Set<string>;
  userNameById: Map<string, string | null>;
  publicPropertyById: Map<string, MarketplacePublicProperty>;
  mediaBySourceUrl: Map<string, MarketplaceMediaReference[]>;
};

export type ProductionMarketplacePlan = {
  sourceRunId: string;
  checksum: string;
  records: MarketplaceTargetRecord[];
  writes: MarketplaceTargetRecord[];
  provenance: ProductionMigrationSourceLink[];
  blockers: IdentityMigrationBlocker[];
  parity: {
    sourceTableCounts: Record<string, number>;
    targetTableCounts: Record<string, number>;
    sourceCountsByProperty: Record<string, Record<string, number>>;
    targetCountsByProperty: Record<string, Record<string, number>>;
    preferenceDraftsByProperty: Record<
      string,
      {
        draft: LegacyMarketplacePreferenceDraftCandidate;
        canonicalTargetRevision: number | null;
      }
    >;
  };
  counts: {
    sourceRows: number;
    plannedRecords: number;
    inserts: number;
    updates: number;
    unchanged: number;
    preservedNewerTarget: number;
    preservedTargetDeletions: number;
  };
};
