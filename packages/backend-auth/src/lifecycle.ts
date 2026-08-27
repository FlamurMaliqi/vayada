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
  "identity.invite.staff.create",
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
  "identity.invite.staff.created",
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

export const hotelStaffRoleKeys = [
  "hotel_manager",
  "front_desk",
  "housekeeping",
  "hotel_custom",
] as const;

export type HotelStaffRoleKey = (typeof hotelStaffRoleKeys)[number];

export const staffAccessPermissionKeys = [
  "pms.dashboard.read",
  "pms.dashboard.operations.read",
  "pms.dashboard.finance.read",
  "pms.calendar.read",
  "pms.calendar.manage",
  "pms.reservation.read",
  "pms.reservation.update",
  "pms.reservation.cancel",
  "pms.inbox.read",
  "pms.inbox.reply",
  "pms.room_status.read",
  "pms.rooms_rates.read",
  "pms.rooms_rates.manage",
  "pms.channel_manager.read",
  "pms.finance.read",
  "pms.settings.read",
  "pms.settings.manage",
  "identity.staff.manage",
  "finance.billing.manage",
  "pms.guest_contact.read",
  "booking.analytics.read",
  "booking.design.read",
  "booking.design.manage",
  "booking.flow.read",
  "booking.flow.manage",
  "booking.settings.read",
  "booking.settings.manage",
] as const satisfies readonly PermissionKey[];

export type StaffAccessPermissionKey = (typeof staffAccessPermissionKeys)[number];

export const staffRoleDefaultPermissions: Readonly<
  Record<HotelStaffRoleKey, readonly StaffAccessPermissionKey[]>
> = {
  hotel_manager: staffAccessPermissionKeys.filter(
    (key) => key !== "identity.staff.manage" && key !== "finance.billing.manage",
  ),
  front_desk: [
    "pms.dashboard.read",
    "pms.dashboard.operations.read",
    "pms.calendar.read",
    "pms.calendar.manage",
    "pms.reservation.read",
    "pms.reservation.update",
    "pms.inbox.read",
    "pms.inbox.reply",
    "pms.room_status.read",
    "pms.rooms_rates.read",
    "pms.guest_contact.read",
  ],
  housekeeping: ["pms.dashboard.read", "pms.calendar.read", "pms.room_status.read"],
  hotel_custom: [],
};

export type StaffPermissionOverrides = {
  grant: readonly StaffAccessPermissionKey[];
  deny: readonly StaffAccessPermissionKey[];
};

export type StaffInviteAccessValidationIssue =
  | "invalid_role"
  | "invalid_property_access_mode"
  | "invalid_property_id"
  | "duplicate_property_id"
  | "unknown_permission_key"
  | "duplicate_permission_key"
  | "conflicting_permission_override"
  | "missing_required_permission"
  | "forbidden_permission";

const requiredLowerPermissions: Partial<
  Record<StaffAccessPermissionKey, readonly StaffAccessPermissionKey[]>
> = {
  "pms.dashboard.operations.read": ["pms.dashboard.read"],
  "pms.dashboard.finance.read": ["pms.dashboard.read", "pms.dashboard.operations.read"],
  "pms.calendar.manage": ["pms.calendar.read"],
  "pms.reservation.update": ["pms.reservation.read"],
  "pms.reservation.cancel": ["pms.reservation.read", "pms.reservation.update"],
  "pms.inbox.reply": ["pms.inbox.read"],
  "pms.rooms_rates.read": ["pms.room_status.read"],
  "pms.rooms_rates.manage": ["pms.room_status.read", "pms.rooms_rates.read"],
  "pms.settings.manage": ["pms.settings.read"],
  "booking.design.manage": ["booking.design.read"],
  "booking.flow.manage": ["booking.flow.read"],
  "booking.settings.manage": ["booking.settings.read"],
};

const canonicalPropertyId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateStaffInviteAccess(input: {
  roleKey: string;
  propertyAccessMode: string;
  propertyIds: readonly string[];
  permissionOverrides: { grant: readonly string[]; deny: readonly string[] };
}): readonly StaffInviteAccessValidationIssue[] {
  const issues = new Set<StaffInviteAccessValidationIssue>();
  if (!hotelStaffRoleKeys.includes(input.roleKey as HotelStaffRoleKey)) issues.add("invalid_role");
  if (input.propertyAccessMode !== "assigned") issues.add("invalid_property_access_mode");

  const propertyIds = new Set<string>();
  for (const propertyId of input.propertyIds) {
    if (!canonicalPropertyId.test(propertyId)) issues.add("invalid_property_id");
    const normalizedPropertyId = propertyId.toLowerCase();
    if (propertyIds.has(normalizedPropertyId)) issues.add("duplicate_property_id");
    propertyIds.add(normalizedPropertyId);
  }

  const knownPermissions = new Set<string>(staffAccessPermissionKeys);
  const grant = new Set<string>();
  const deny = new Set<string>();
  for (const [keys, seen] of [
    [input.permissionOverrides.grant, grant],
    [input.permissionOverrides.deny, deny],
  ] as const) {
    for (const key of keys) {
      if (!knownPermissions.has(key)) issues.add("unknown_permission_key");
      if (seen.has(key)) issues.add("duplicate_permission_key");
      seen.add(key);
    }
  }

  if ([...grant].some((key) => deny.has(key))) issues.add("conflicting_permission_override");
  if (grant.has("identity.staff.manage") || grant.has("finance.billing.manage")) {
    issues.add("forbidden_permission");
  }
  if (input.roleKey === "housekeeping" && grant.has("pms.guest_contact.read")) {
    issues.add("forbidden_permission");
  }
  const roleKey = input.roleKey as HotelStaffRoleKey;
  const effectivePermissions = new Set<StaffAccessPermissionKey>(
    hotelStaffRoleKeys.includes(roleKey) ? staffRoleDefaultPermissions[roleKey] : [],
  );
  for (const key of grant) {
    if (knownPermissions.has(key)) effectivePermissions.add(key as StaffAccessPermissionKey);
  }
  for (const key of deny) effectivePermissions.delete(key as StaffAccessPermissionKey);
  for (const key of effectivePermissions) {
    const lowerKeys = requiredLowerPermissions[key] ?? [];
    if (lowerKeys.some((lowerKey) => !effectivePermissions.has(lowerKey))) {
      issues.add("missing_required_permission");
    }
  }
  return [...issues];
}

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

export type CreateStaffInvitePayload = {
  organizationId: string;
  email: string;
  name?: string;
  roleKey: HotelStaffRoleKey;
  propertyAccessMode: "assigned";
  propertyIds: readonly string[];
  permissionOverrides: StaffPermissionOverrides;
  configurationRevision: number;
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

export type StaffInviteAudit = IdentityCommandAudit & {
  actor: Extract<IdentityCommandActor, { kind: "user" }> & { organizationId: string };
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

export type CreateStaffInviteCommand = IdentityLifecycleCommandBase<
  "identity.invite.staff.create",
  CreateStaffInvitePayload
> & {
  audit: StaffInviteAudit;
};

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
  | CreateStaffInviteCommand
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

export type StaffInviteCreatedEvent = IdentityLifecycleEventBase<
  "identity.invite.staff.created",
  CreateStaffInvitePayload
> & { audit: StaffInviteAudit };

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
  | StaffInviteCreatedEvent
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
