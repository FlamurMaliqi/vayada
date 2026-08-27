// Types
export type {
  ActiveMembership,
  AuthProvider,
  EntitlementStatus,
  InternalUserStatus,
  LinkedResource,
  MembershipStatus,
  OrganizationKind,
  OrganizationStatus,
  PermissionKey,
  Product,
  ProductEntitlement,
  ProviderIdentity,
  RequestActor,
  RequestAuditMetadata,
  RequestContext,
  RequestSource,
  ResourceRelationship,
  ResourceType,
  SelectedOrganization,
} from "./types.js";

export {
  identityLifecycleCommandTypes,
  identityLifecycleEventTypes,
  identityLifecycleIdempotencyScope,
  hasValidStaffPermissionHierarchy,
  hotelStaffRoleKeys,
  membershipPropertyAccessModeForProvisioning,
  staffAccessPermissionKeys,
  staffRoleDefaultPermissions,
  validateStaffInviteAccess,
  type ConsentCommandInput,
  type CreateAffiliateInviteCommand,
  type CreateAffiliateInvitePayload,
  type CreateCustomerInviteCommand,
  type CreateCustomerInvitePayload,
  type CreateStaffInviteCommand,
  type CreateStaffInvitePayload,
  type CreateIdentityRecoveryFlowCommand,
  type CreateIdentityRecoveryFlowPayload,
  type CreateIdentityUserCommand,
  type CreateIdentityUserPayload,
  type DeleteIdentityUserCommand,
  type DeleteIdentityUserPayload,
  type GrantIdentityAccessCommand,
  type GrantIdentityAccessPayload,
  type GrantIdentityResourceLinksCommand,
  type GrantIdentityResourceLinksPayload,
  type IdentityCommandActor,
  type IdentityCommandAudit,
  type IdentityLifecycleCommand,
  type IdentityLifecycleCommandBus,
  type IdentityLifecycleCommandResult,
  type IdentityLifecycleCommandType,
  type IdentityLifecycleEvent,
  type IdentityLifecycleEventBase,
  type IdentityLifecycleEventType,
  type MembershipCommandInput,
  type MembershipPropertyAccessMode,
  type HotelStaffRoleKey,
  type OrganizationCommandInput,
  type PermissionGrantCommandInput,
  type ProductResourceReference,
  type RecoveryFlowKind,
  type ResourceLinkCommandInput,
  type ResourceLinkCommandTarget,
  type StaffAccessPermissionKey,
  type StaffInviteAccessValidationIssue,
  type StaffInviteAudit,
  type StaffInviteCreatedEvent,
  type StaffPermissionOverrides,
  type RevokeIdentityAccessCommand,
  type RevokeIdentityAccessPayload,
  type SuspendIdentityUserCommand,
  type SuspendIdentityUserPayload,
  type UpdateIdentityUserEmailCommand,
  type UpdateIdentityUserEmailPayload,
  type UpdateIdentityUserProfileCommand,
  type UpdateIdentityUserProfilePayload,
  type UpdateIdentityUserStatusCommand,
  type UpdateIdentityUserStatusPayload,
} from "./lifecycle.js";

// Errors
export { AuthError, UnauthorizedError, type AuthErrorCode } from "./errors.js";

// Token verification
export {
  createFakeVerifier,
  createWorkOSVerifier,
  extractBearerToken,
  type TokenVerifier,
  type VerifiedSession,
  type WorkOSVerifierConfig,
} from "./verify.js";

// Identity repository
export {
  createPgIdentityRepository,
  type IdentityMembership,
  type IdentityMembershipOrganization,
  type IdentityOrganization,
  type IdentityRepository,
  type IdentityResourceLink,
  type IdentityUser,
  type RepositoryConfig,
} from "./repository.js";

export { createPgStaffInvitationRepository } from "./staffInvitations.js";
export {
  createPgStaffInvitationAcceptanceRepository,
  type StaffInvitationAcceptanceEvent,
  type StaffInvitationAcceptanceResult,
} from "./staffInvitationAcceptance.js";
export {
  createPgStaffInvitationDeliveryRepository,
  createStaffInvitationDeliveryCoordinator,
  type StaffInvitationDeliveryClaim,
  type StaffInvitationDeliveryRepository,
  type StaffInvitationProvider,
  type StaffInvitationProviderResponse,
  type StaffInvitationProviderRole,
} from "./staffInvitationDelivery.js";

// RequestContext resolution
export {
  resolveRequestContext,
  type AuthorizationResolution,
  type AuthorizationResolver,
  type ResolveOptions,
} from "./resolve.js";

// Fastify plugin
export {
  backendAuthPlugin,
  getAuthContext,
  requireAuthContext,
  type BackendAuthPluginOptions,
} from "./plugin.js";
