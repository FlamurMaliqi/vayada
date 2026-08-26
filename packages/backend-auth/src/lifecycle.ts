import type {
  AuthProvider,
  InternalUserStatus,
  MembershipStatus,
  OrganizationKind,
  OrganizationStatus,
  PermissionKey,
  Product,
  RequestSource,
  ResourceRelationship,
  ResourceType,
} from "./types.js";

export const identityLifecycleCommandTypes = [
  "identity.user.create",
  "identity.user.profile.update",
  "identity.user.email.update",
  "identity.user.status.update",
  "identity.user.suspend",
  "identity.user.delete",
  "identity.access.grant",
  "identity.access.revoke",
  "identity.resource_links.grant",
  "identity.recovery.flow.create",
  "identity.invite.affiliate.create",
  "identity.invite.customer.create",
  "identity.consent.cookie.upsert",
  "identity.consent.marketing.update",
  "identity.gdpr.export.request",
  "identity.gdpr.deletion.request",
  "identity.gdpr.deletion.cancel",
] as const;

export type IdentityLifecycleCommandType = (typeof identityLifecycleCommandTypes)[number];

export const identityLifecycleEventTypes = [
  "identity.user.created",
  "identity.user.profile.updated",
  "identity.user.email.updated",
  "identity.user.status.updated",
  "identity.user.suspended",
  "identity.user.deleted",
  "identity.access.granted",
  "identity.access.revoked",
  "identity.resource_links.granted",
  "identity.recovery.flow.created",
  "identity.invite.affiliate.created",
  "identity.invite.customer.created",
  "identity.consent.cookie.upserted",
  "identity.consent.marketing.updated",
  "identity.gdpr.export.requested",
  "identity.gdpr.deletion.requested",
  "identity.gdpr.deletion.cancelled",
] as const;

export type IdentityLifecycleEventType = (typeof identityLifecycleEventTypes)[number];

export type IdentityCommandActor =
  | {
      kind: "user";
      userId: string;
      organizationId?: string;
    }
  | {
      kind: "system";
      service: string;
    }
  | {
      kind: "migration";
      runId: string;
    };

export type IdentityCommandAudit = {
  actor: IdentityCommandActor;
  source: RequestSource;
  requestId: string;
  correlationId?: string;
  reason: string;
  requestedAt: string;
};

export type OrganizationCommandInput = {
  organizationId?: string;
  kind: OrganizationKind;
  name: string;
  websiteUrl?: string | null;
  slug?: string;
  status?: OrganizationStatus;
  workosOrgId?: string;
  workosExternalId?: string;
};

export type MembershipPropertyAccessMode = "all" | "assigned";

export function membershipPropertyAccessModeForProvisioning(
  organizationKind: OrganizationKind,
  roleKey: string,
): MembershipPropertyAccessMode {
  if (organizationKind !== "hotel_group") return "assigned";
  return roleKey === "hotel_owner" || roleKey === "owner" || roleKey === "operator"
    ? "all"
    : "assigned";
}

export type MembershipCommandInput = {
  organizationId?: string;
  userId?: string;
  status?: MembershipStatus;
  roleKey: string;
  propertyAccessMode: MembershipPropertyAccessMode;
  permissionKeys?: readonly PermissionKey[];
  workosMembershipId?: string;
  workosRoleSlugs?: readonly string[];
  invitedAt?: string;
};

export type ResourceLinkCommandInput = {
  organizationId?: string;
  product: Product;
  resourceType: ResourceType;
  resourceId: string;
  relationship: ResourceRelationship;
  status?: "active" | "suspended" | "archived";
};

export type ProductResourceReference = {
  product: Product;
  resourceType: ResourceType;
  resourceId: string;
};

export type ResourceLinkCommandTarget = ProductResourceReference & {
  relationship: ResourceRelationship;
  status?: "suspended" | "archived";
};

export type PermissionGrantCommandInput = {
  organizationKind: OrganizationKind;
  roleKey: string;
  permissionKey: PermissionKey;
};

export type ConsentCommandInput = {
  termsVersion?: string;
  privacyVersion?: string;
  marketingConsent?: boolean;
  acceptedAt?: string;
};

export type CreateIdentityUserPayload = {
  email: string;
  name?: string;
  initialStatus: InternalUserStatus;
  /**
   * Temporary migration input for legacy admin surfaces while product profile
   * resources move behind organization/resource links.
   */
  legacyUserType?: "creator" | "hotel" | "admin";
  providerIdentity?: {
    provider: AuthProvider;
    providerUserId?: string;
    providerEmailVerified?: boolean;
  };
  consent?: ConsentCommandInput;
  organization?: OrganizationCommandInput;
  membership?: MembershipCommandInput;
  resourceLinks?: readonly ResourceLinkCommandInput[];
};

export type UpdateIdentityUserProfilePayload = {
  userId: string;
  name?: string;
  phone?: string | null;
  profilePictureUrl?: string | null;
  profilePictureMediaObjectId?: string | null;
};

export type UpdateIdentityUserEmailPayload = {
  userId: string;
  email: string;
  providerEmailVerified?: boolean;
};

export type UpdateIdentityUserStatusPayload = {
  userId: string;
  status: InternalUserStatus;
};

export type SuspendIdentityUserPayload = {
  userId: string;
  reason: string;
  suspendMemberships?: boolean;
  suspendResourceLinks?: boolean;
};

export type DeleteIdentityUserPayload = {
  userId: string;
  mode: "soft_delete" | "privacy_erasure";
  retainAuditUntil?: string;
};

export type GrantIdentityAccessPayload = {
  userId: string;
  organization: OrganizationCommandInput;
  membership: MembershipCommandInput;
  resourceLinks?: readonly ResourceLinkCommandInput[];
  permissionGrants?: readonly PermissionGrantCommandInput[];
};

export type RevokeIdentityAccessPayload = {
  userId: string;
  organizationId: string;
  membershipStatus?: Extract<MembershipStatus, "inactive" | "suspended">;
  resourceLinks?: readonly ResourceLinkCommandTarget[];
  permissionGrants?: readonly PermissionGrantCommandInput[];
};

export type GrantIdentityResourceLinksPayload = {
  organizationId: string;
  resourceLinks: readonly (Omit<ResourceLinkCommandInput, "organizationId" | "status"> & {
    status?: "active";
  })[];
};

export type RecoveryFlowKind =
  | "account_recovery"
  | "password_reset"
  | "email_verification"
  | "email_change";

type RecoveryFlowTarget =
  | {
      userId: string;
      email?: string;
    }
  | {
      userId?: string;
      email: string;
    };

export type CreateIdentityRecoveryFlowPayload =
  | (RecoveryFlowTarget & {
      flowKind: "account_recovery" | "password_reset" | "email_verification";
      redirectUrl?: string;
    })
  | {
      flowKind: "email_change";
      userId: string;
      newEmail: string;
      redirectUrl?: string;
    };

export type CreateAffiliateInvitePayload = {
  email: string;
  name?: string;
  organization: OrganizationCommandInput;
  membership: MembershipCommandInput;
  affiliateResourceLink: ResourceLinkCommandInput & {
    product: "affiliate";
    resourceType: "affiliate";
  };
};

export type CreateCustomerInvitePayload = {
  email: string;
  name?: string;
  bookingReference?: {
    bookingId?: string;
    hotelResource?: ProductResourceReference & {
      product: "booking";
      resourceType: "booking_hotel";
    };
  };
  // Customer accounts do not imply hotel ownership or staff membership.
  membership?: never;
  resourceLinks?: never;
};

export type CookieConsentPayload = {
  visitorId: string;
  userId?: string;
  necessary: true;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
};

export type UpdateMarketingConsentPayload = {
  userId: string;
  marketingConsent: boolean;
};

export type RequestGdprExportPayload = {
  userId: string;
  requestId?: string;
  expiresAt?: string;
};

export type RequestGdprDeletionPayload = {
  userId: string;
  requestId?: string;
  scheduledDeletionAt: string;
};

export type CancelGdprDeletionPayload = {
  userId: string;
  requestId?: string;
};

export type IdentityLifecycleCommandBase<
  TCommandType extends IdentityLifecycleCommandType,
  TPayload,
> = {
  commandType: TCommandType;
  commandId: string;
  idempotencyKey: string;
  audit: IdentityCommandAudit;
  payload: TPayload;
};

export type CreateIdentityUserCommand = IdentityLifecycleCommandBase<
  "identity.user.create",
  CreateIdentityUserPayload
>;

export type UpdateIdentityUserProfileCommand = IdentityLifecycleCommandBase<
  "identity.user.profile.update",
  UpdateIdentityUserProfilePayload
>;

export type UpdateIdentityUserEmailCommand = IdentityLifecycleCommandBase<
  "identity.user.email.update",
  UpdateIdentityUserEmailPayload
>;

export type UpdateIdentityUserStatusCommand = IdentityLifecycleCommandBase<
  "identity.user.status.update",
  UpdateIdentityUserStatusPayload
>;

export type SuspendIdentityUserCommand = IdentityLifecycleCommandBase<
  "identity.user.suspend",
  SuspendIdentityUserPayload
>;

export type DeleteIdentityUserCommand = IdentityLifecycleCommandBase<
  "identity.user.delete",
  DeleteIdentityUserPayload
>;

export type GrantIdentityAccessCommand = IdentityLifecycleCommandBase<
  "identity.access.grant",
  GrantIdentityAccessPayload
>;

export type RevokeIdentityAccessCommand = IdentityLifecycleCommandBase<
  "identity.access.revoke",
  RevokeIdentityAccessPayload
>;

export type GrantIdentityResourceLinksCommand = IdentityLifecycleCommandBase<
  "identity.resource_links.grant",
  GrantIdentityResourceLinksPayload
>;

export type CreateIdentityRecoveryFlowCommand = IdentityLifecycleCommandBase<
  "identity.recovery.flow.create",
  CreateIdentityRecoveryFlowPayload
>;

export type CreateAffiliateInviteCommand = IdentityLifecycleCommandBase<
  "identity.invite.affiliate.create",
  CreateAffiliateInvitePayload
>;

export type CreateCustomerInviteCommand = IdentityLifecycleCommandBase<
  "identity.invite.customer.create",
  CreateCustomerInvitePayload
>;

export type UpsertCookieConsentCommand = IdentityLifecycleCommandBase<
  "identity.consent.cookie.upsert",
  CookieConsentPayload
>;

export type UpdateMarketingConsentCommand = IdentityLifecycleCommandBase<
  "identity.consent.marketing.update",
  UpdateMarketingConsentPayload
>;

export type RequestGdprExportCommand = IdentityLifecycleCommandBase<
  "identity.gdpr.export.request",
  RequestGdprExportPayload
>;

export type RequestGdprDeletionCommand = IdentityLifecycleCommandBase<
  "identity.gdpr.deletion.request",
  RequestGdprDeletionPayload
>;

export type CancelGdprDeletionCommand = IdentityLifecycleCommandBase<
  "identity.gdpr.deletion.cancel",
  CancelGdprDeletionPayload
>;

export type IdentityLifecycleCommand =
  | CreateIdentityUserCommand
  | UpdateIdentityUserProfileCommand
  | UpdateIdentityUserEmailCommand
  | UpdateIdentityUserStatusCommand
  | SuspendIdentityUserCommand
  | DeleteIdentityUserCommand
  | GrantIdentityAccessCommand
  | RevokeIdentityAccessCommand
  | GrantIdentityResourceLinksCommand
  | CreateIdentityRecoveryFlowCommand
  | CreateAffiliateInviteCommand
  | CreateCustomerInviteCommand
  | UpsertCookieConsentCommand
  | UpdateMarketingConsentCommand
  | RequestGdprExportCommand
  | RequestGdprDeletionCommand
  | CancelGdprDeletionCommand;

export type IdentityLifecycleEventBase<TEventType extends IdentityLifecycleEventType, TPayload> = {
  eventType: TEventType;
  eventId: string;
  commandId: string;
  idempotencyKey: string;
  userId?: string;
  organizationId?: string;
  resourceLinks?: readonly ResourceLinkCommandInput[];
  occurredAt: string;
  audit: IdentityCommandAudit;
  payload: TPayload;
};

export type IdentityLifecycleEvent =
  | IdentityLifecycleEventBase<"identity.user.created", CreateIdentityUserPayload>
  | IdentityLifecycleEventBase<"identity.user.profile.updated", UpdateIdentityUserProfilePayload>
  | IdentityLifecycleEventBase<"identity.user.email.updated", UpdateIdentityUserEmailPayload>
  | IdentityLifecycleEventBase<"identity.user.status.updated", UpdateIdentityUserStatusPayload>
  | IdentityLifecycleEventBase<"identity.user.suspended", SuspendIdentityUserPayload>
  | IdentityLifecycleEventBase<"identity.user.deleted", DeleteIdentityUserPayload>
  | IdentityLifecycleEventBase<"identity.access.granted", GrantIdentityAccessPayload>
  | IdentityLifecycleEventBase<"identity.access.revoked", RevokeIdentityAccessPayload>
  | IdentityLifecycleEventBase<"identity.resource_links.granted", GrantIdentityResourceLinksPayload>
  | IdentityLifecycleEventBase<"identity.recovery.flow.created", CreateIdentityRecoveryFlowPayload>
  | IdentityLifecycleEventBase<"identity.invite.affiliate.created", CreateAffiliateInvitePayload>
  | IdentityLifecycleEventBase<"identity.invite.customer.created", CreateCustomerInvitePayload>
  | IdentityLifecycleEventBase<"identity.consent.cookie.upserted", CookieConsentPayload>
  | IdentityLifecycleEventBase<"identity.consent.marketing.updated", UpdateMarketingConsentPayload>
  | IdentityLifecycleEventBase<"identity.gdpr.export.requested", RequestGdprExportPayload>
  | IdentityLifecycleEventBase<"identity.gdpr.deletion.requested", RequestGdprDeletionPayload>
  | IdentityLifecycleEventBase<"identity.gdpr.deletion.cancelled", CancelGdprDeletionPayload>;

export type IdentityLifecycleCommandResult = {
  status: "accepted" | "idempotent_replay";
  commandId: string;
  idempotencyKey: string;
  userId?: string;
  organizationId?: string;
  events: readonly IdentityLifecycleEvent[];
};

export interface IdentityLifecycleCommandBus {
  execute(command: IdentityLifecycleCommand): Promise<IdentityLifecycleCommandResult>;
}

export function identityLifecycleIdempotencyScope(command: IdentityLifecycleCommand): string {
  return `${command.commandType}:${command.idempotencyKey}`;
}
