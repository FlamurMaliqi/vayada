import type { IdentityMigrationBlocker, IdentitySourceRow } from "./productionIdentityDisposition.js";

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

export type ProductionBookingTargetState = {
  propertyLinks: BookingPropertyLink[];
  propertySlugs: BookingPropertySlug[];
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
};
