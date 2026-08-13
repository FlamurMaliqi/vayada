// RequestContext types for the TypeScript backend.
// These are the canonical definitions — apps/api/src/platform/requestContext.ts
// re-exports from this package. When a domain-identity package is introduced,
// these will move there.

export type AuthProvider = "workos";

export type InternalUserStatus = "active" | "pending" | "suspended" | "deleted";

export type OrganizationKind =
  | "platform"
  | "hotel_group"
  | "creator_workspace"
  | "affiliate_partner";

export type OrganizationStatus = "active" | "suspended" | "archived";

export type MembershipStatus = "active" | "pending" | "inactive" | "suspended";

export type Product =
  | "platform"
  | "hotel_catalog"
  | "marketplace"
  | "booking"
  | "pms"
  | "affiliate";

export type ResourceType =
  | "platform"
  | "user_profile"
  | "property"
  | "booking_hotel"
  | "pms_hotel"
  | "pms_property"
  | "hotel_profile"
  | "marketplace_offer"
  | "creator_profile"
  | "affiliate"
  | "payout_account";

export type ResourceRelationship =
  | "owner"
  | "operator"
  | "front_desk"
  | "finance_manager"
  | "promotes"
  | "billing_account";

export type PermissionKey =
  | "platform.admin.read"
  | "platform.finance.read"
  | "platform.property.status.manage"
  | "platform.user.suspend"
  | "hotel_catalog.setup.read"
  | "hotel_catalog.setup.manage"
  | "hotel_catalog.products.manage"
  | "booking.settings.manage"
  | "booking.settings.read"
  | "booking.analytics.read"
  | "booking.reservation.read"
  | "pms.read"
  | "pms.operations.read"
  | "pms.operations.manage"
  | "pms.booking.update"
  | "pms.finance.read"
  | "pms.finance.manage"
  | "marketplace.collaboration.read"
  | "marketplace.collaboration.write"
  | "marketplace.collaboration.review"
  | "marketplace.profile.manage"
  | "marketplace.trip.read"
  | "marketplace.trip.manage"
  | "affiliate.payout.manage";

export type EntitlementStatus = "active" | "suspended" | "expired";

export type RequestSource = "web" | "admin" | "api" | "agent" | "migration";

export type ProviderIdentity = {
  provider: AuthProvider;
  providerUserId: string;
  sessionId?: string;
  providerOrganizationId?: string;
};

export type RequestActor = {
  internalUserId: string;
  providerIdentity: ProviderIdentity;
  email: string;
  status: InternalUserStatus;
};

export type SelectedOrganization = {
  organizationId: string;
  workosOrgId?: string;
  name?: string;
  kind: OrganizationKind;
  status: OrganizationStatus;
};

export type ActiveMembership = {
  membershipId: string;
  status: MembershipStatus;
  roleKey: string;
  workosMembershipId?: string;
  workosRoleSlugs: string[];
  // Populated by backend-authorization after this package resolves identity.
  permissions: PermissionKey[];
};

export type LinkedResource = {
  product: Product;
  resourceType: ResourceType;
  resourceId: string;
  relationship: ResourceRelationship;
  status: "active" | "suspended" | "archived";
};

export type ProductEntitlement = {
  product: Product;
  key: string;
  status: EntitlementStatus;
  resource?: Pick<LinkedResource, "product" | "resourceType" | "resourceId">;
};

export type RequestAuditMetadata = {
  requestId: string;
  correlationId?: string;
  source: RequestSource;
  sourceIp?: string;
  userAgent?: string;
  receivedAt: string;
};

export type RequestContext = {
  actor: RequestActor;
  selectedOrganization: SelectedOrganization;
  membership: ActiveMembership;
  linkedResources: LinkedResource[];
  // Entitlements populated by backend-authorization; empty until that package is wired.
  entitlements: ProductEntitlement[];
  locale: string;
  currency: string;
  audit: RequestAuditMetadata;
};
