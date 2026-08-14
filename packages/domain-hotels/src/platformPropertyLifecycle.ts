import type { CreatePropertyProfileRequest } from "./propertyProfile.js";

export const PLATFORM_PROPERTY_LIFECYCLE_CONTRACT_VERSION =
  "platform-property-lifecycle.v1" as const;
export const PLATFORM_PROPERTY_LIFECYCLE_STATUSES = [
  "provisioning",
  "active",
  "suspended",
  "retired",
] as const;

export type PlatformPropertyLifecycleStatus = (typeof PLATFORM_PROPERTY_LIFECYCLE_STATUSES)[number];

const ALLOWED_TRANSITIONS = {
  provisioning: ["active", "suspended", "retired"],
  active: ["suspended", "retired"],
  suspended: ["active", "retired"],
  retired: ["suspended"],
} as const satisfies Record<
  PlatformPropertyLifecycleStatus,
  readonly PlatformPropertyLifecycleStatus[]
>;

export function isPlatformPropertyLifecycleStatus(
  value: unknown,
): value is PlatformPropertyLifecycleStatus {
  return PLATFORM_PROPERTY_LIFECYCLE_STATUSES.includes(value as PlatformPropertyLifecycleStatus);
}

export function canTransitionPlatformProperty(
  from: PlatformPropertyLifecycleStatus,
  to: PlatformPropertyLifecycleStatus,
): boolean {
  return (ALLOWED_TRANSITIONS[from] as readonly PlatformPropertyLifecycleStatus[]).includes(to);
}

export type PlatformPropertyProvisionRequest = {
  accountUserId: string;
  provisioningReference: string;
  reason: string;
  profile: CreatePropertyProfileRequest;
};

export type PlatformPropertyStatusCommand = {
  expectedLifecycleRevision: number;
  status: Exclude<PlatformPropertyLifecycleStatus, "provisioning" | "retired">;
  reason: string;
};

export type PlatformPropertyRetireCommand = {
  expectedLifecycleRevision: number;
  confirmation: "RETIRE";
  reason: string;
};

export type PlatformPropertyLifecycleResult = {
  contractVersion: typeof PLATFORM_PROPERTY_LIFECYCLE_CONTRACT_VERSION;
  propertyId: string;
  lifecycleStatus: PlatformPropertyLifecycleStatus;
  lifecycleRevision: number;
};

export type PlatformPropertyImpactBlocker = {
  code: "active_bookings" | "unresolved_payments" | "open_payouts" | "connected_channels";
  ownerDomain: "booking" | "finance" | "pms";
  count: number;
  message: string;
};

export type PlatformPropertyRetirementImpact = PlatformPropertyLifecycleResult & {
  organizations: { linked: number };
  entitlements: { active: number; suspended: number };
  bookings: { total: number; active: number };
  inventory: { roomTypes: number; rooms: number };
  finance: {
    totalPayments: number;
    unresolvedPayments: number;
    totalPayouts: number;
    openPayouts: number;
    billingEntitlements: number;
  };
  media: { objects: number };
  publicExposure: {
    marketplaceActive: boolean;
    distributionStatus: string | null;
    bookingRevisionActive: boolean;
  };
  blockers: PlatformPropertyImpactBlocker[];
  canRetire: boolean;
  hardDeletion: {
    allowed: false;
    reason: "hard_delete_not_supported";
  };
};
