import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";

export type BookingTargetRecord = {
  targetProduct: "booking" | "platform";
  targetTable: string;
  targetId: string;
  sourceDatabase: "booking" | "pms";
  sourceTable: string;
  sourceId: string;
  sourceChecksum: string;
  sourceUpdatedAt: string | null;
  mutable: boolean;
  row: Record<string, unknown>;
};

export type ExistingBookingTargetRecord = {
  targetProduct: string;
  targetTable: string;
  targetId: string;
  updatedAt: string | null;
  row: Record<string, unknown>;
};

export type ProductionMigrationSourceLink = {
  sourceDatabase: string;
  sourceTable: string;
  sourceId: string;
  targetProduct: string;
  targetTable: string;
  targetId: string;
  sourceChecksum: string;
  sourceUpdatedAt: string | null;
  lastMigratedAt: string;
};

export type BookingPropertyLink = {
  sourceSystem: string;
  sourceTable: string;
  sourceId: string;
  propertyId: string;
  relationship: string;
  status: string;
};

export type BookingPropertySlug = {
  slug: string;
  propertyId: string;
  purpose: string;
  status: string;
};

export type BookingMediaReference = {
  mediaObjectId: string;
  propertyId: string;
  sourceUrl: string;
  sourceTable: string;
  sourceRowId: string;
  purpose: string;
  visibility: string;
  lifecycleStatus: string;
  publicApproved: boolean;
  publicUrl: string | null;
  bucket: string;
  storageKind: string;
  storageKey: string;
  variantStorageKey: string | null;
  migrationRunId: string | null;
};

export type ProductionBookingTargetState = {
  propertyLinks: BookingPropertyLink[];
  propertySlugs: BookingPropertySlug[];
  media?: BookingMediaReference[];
  records: ExistingBookingTargetRecord[];
  provenance: ProductionMigrationSourceLink[];
  blockers?: IdentityMigrationBlocker[];
};

export type ProductionBookingPlan = {
  sourceRunId: string;
  checksum: string;
  records: BookingTargetRecord[];
  writes: BookingTargetRecord[];
  provenance: ProductionMigrationSourceLink[];
  blockers: IdentityMigrationBlocker[];
  parity: {
    sourceTableCounts: Record<string, number>;
    targetTableCounts: Record<string, number>;
    sourceBookingStatuses: Record<string, number>;
    plannedBookingLifecycleStatuses: Record<string, number>;
    activeFutureSourceBookings: Record<
      string,
      { lifecycleStatus: string; checkIn: string; checkOut: string }
    >;
    activeFutureTargetBookings: Record<
      string,
      { lifecycleStatus: string; checkIn: string; checkOut: string }
    >;
    sourceDraftMaterialization: Record<string, number>;
    plannedDraftStatuses: Record<string, number>;
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

export type BookingBuildContext = {
  sourceRunId: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionBookingTargetState;
  blockers: IdentityMigrationBlocker[];
  propertyBySource: Map<string, string>;
  propertyBySlug: Map<string, string>;
  bookingById: Map<string, IdentitySourceRow>;
  bookingByReference: Map<string, IdentitySourceRow>;
  addonById: Map<string, IdentitySourceRow>;
  promoById: Map<string, IdentitySourceRow>;
  mediaBySource: Map<string, BookingMediaReference>;
};
