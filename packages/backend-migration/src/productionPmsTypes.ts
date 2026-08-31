import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import type { ProductionMigrationSourceLink } from "./productionBookingTypes.js";

export type PmsTargetRecord = {
  targetProduct: "pms" | "platform";
  targetTable: string;
  targetId: string;
  sourceDatabase: "pms";
  sourceTable: string;
  sourceId: string;
  sourceChecksum: string;
  sourceUpdatedAt: string | null;
  mutable: boolean;
  row: Record<string, unknown>;
};

export type ExistingPmsTargetRecord = {
  targetProduct: string;
  targetTable: string;
  targetId: string;
  updatedAt: string | null;
  row: Record<string, unknown>;
};

export type PmsPropertyLink = {
  sourceId: string;
  propertyId: string;
  relationship: string;
  status: string;
  migrationRunId: string | null;
};

export type PmsTargetBooking = {
  id: string;
  propertyId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  roomCount: number;
  currency: string;
  lifecycleStatus: string;
  updatedAt: string | null;
  migrationRunId: string | null;
};

export type ProductionPmsTargetState = {
  propertyLinks: PmsPropertyLink[];
  bookings: PmsTargetBooking[];
  userIds: string[];
  mediaIds: string[];
  records: ExistingPmsTargetRecord[];
  provenance: ProductionMigrationSourceLink[];
  blockers?: IdentityMigrationBlocker[];
};

export type PmsBuildContext = {
  sourceRunId: string;
  snapshotAt: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionPmsTargetState;
  blockers: IdentityMigrationBlocker[];
  rowsByTable: Map<string, IdentitySourceRow[]>;
  propertyByHotel: Map<string, string>;
  hotelById: Map<string, IdentitySourceRow>;
  bookingById: Map<string, IdentitySourceRow>;
  targetBookingById: Map<string, PmsTargetBooking>;
  roomTypeById: Map<string, IdentitySourceRow>;
  roomById: Map<string, IdentitySourceRow>;
  connectionByHotel: Map<string, IdentitySourceRow>;
  linkedGroupByRoomType: Map<string, string>;
  userIds: Set<string>;
  mediaIds: Set<string>;
};

export type PmsRoomBuild = {
  records: PmsTargetRecord[];
  flexiblePlanByRoomType: Map<string, string>;
  channelPlanByMapping: Map<string, string>;
};

export type PmsAssignmentBuild = {
  records: PmsTargetRecord[];
  assignmentByBookingPosition: Map<string, string>;
};

export type ProductionPmsPlan = {
  sourceRunId: string;
  checksum: string;
  records: PmsTargetRecord[];
  writes: PmsTargetRecord[];
  provenance: ProductionMigrationSourceLink[];
  blockers: IdentityMigrationBlocker[];
  parity: {
    sourceTableCounts: Record<string, number>;
    targetTableCounts: Record<string, number>;
    sourceCountsByProperty: Record<string, Record<string, number>>;
    targetCountsByProperty: Record<string, Record<string, number>>;
    futureInventoryByProperty: Record<
      string,
      { days: number; assigned: number; blocked: number; available: number; stopSell: number }
    >;
    expectedActiveRoomTypesByProperty: Record<string, string[]>;
    actualActiveRoomTypesByProperty: Record<string, string[]>;
    futureInventoryByRoomType: Record<
      string,
      {
        propertyId: string;
        roomTypeId: string;
        firstStayDate: string;
        lastStayDate: string;
        distinctDays: number;
        rows: number;
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
