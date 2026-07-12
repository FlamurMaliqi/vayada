import type { RequestContext, RequestContextFixtureCase } from "./requestContext.js";

const baseAudit = {
  source: "web",
  receivedAt: "2026-06-04T07:00:00.000Z",
} as const;

const hotelOwnerContext: RequestContext = {
  actor: {
    internalUserId: "user_hotel_owner",
    providerIdentity: {
      provider: "workos",
      providerUserId: "user_workos_hotel_owner",
      sessionId: "session_hotel_owner",
      providerOrganizationId: "org_workos_hotel_group",
    },
    email: "owner@example.com",
    status: "active",
  },
  selectedOrganization: {
    organizationId: "org_hotel_group",
    workosOrgId: "org_workos_hotel_group",
    kind: "hotel_group",
    status: "active",
  },
  membership: {
    membershipId: "membership_hotel_owner",
    status: "active",
    roleKey: "hotel_owner",
    workosMembershipId: "om_hotel_owner",
    workosRoleSlugs: ["hotel_owner"],
    permissions: [
      "booking.settings.manage",
      "booking.reservation.read",
      "pms.booking.update",
      "marketplace.collaboration.read",
    ],
  },
  linkedResources: [
    {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: "booking_hotel_alpenrose",
      relationship: "owner",
      status: "active",
    },
    {
      product: "pms",
      resourceType: "pms_hotel",
      resourceId: "pms_hotel_alpenrose",
      relationship: "operator",
      status: "active",
    },
    {
      product: "marketplace",
      resourceType: "marketplace_offer",
      resourceId: "marketplace_offer_alpenrose",
      relationship: "operator",
      status: "active",
    },
  ],
  entitlements: [
    {
      product: "booking",
      key: "booking-engine",
      status: "active",
    },
    {
      product: "pms",
      key: "pms-core",
      status: "active",
    },
  ],
  locale: "en-US",
  currency: "EUR",
  audit: {
    ...baseAudit,
    requestId: "req_hotel_owner",
  },
};

const creatorContext: RequestContext = {
  actor: {
    internalUserId: "user_creator",
    providerIdentity: {
      provider: "workos",
      providerUserId: "user_workos_creator",
      sessionId: "session_creator",
      providerOrganizationId: "org_workos_creator",
    },
    email: "creator@example.com",
    status: "active",
  },
  selectedOrganization: {
    organizationId: "org_creator_workspace",
    workosOrgId: "org_workos_creator",
    kind: "creator_workspace",
    status: "active",
  },
  membership: {
    membershipId: "membership_creator",
    status: "active",
    roleKey: "creator_owner",
    workosMembershipId: "om_creator",
    workosRoleSlugs: ["creator_owner"],
    permissions: ["marketplace.profile.manage", "marketplace.collaboration.read"],
  },
  linkedResources: [
    {
      product: "marketplace",
      resourceType: "creator_profile",
      resourceId: "creator_profile_lina",
      relationship: "owner",
      status: "active",
    },
  ],
  entitlements: [],
  locale: "en-US",
  currency: "EUR",
  audit: {
    ...baseAudit,
    requestId: "req_creator",
  },
};

const affiliateContext: RequestContext = {
  actor: {
    internalUserId: "user_affiliate",
    providerIdentity: {
      provider: "workos",
      providerUserId: "user_workos_affiliate",
      sessionId: "session_affiliate",
      providerOrganizationId: "org_workos_affiliate",
    },
    email: "affiliate@example.com",
    status: "active",
  },
  selectedOrganization: {
    organizationId: "org_affiliate_partner",
    workosOrgId: "org_workos_affiliate",
    kind: "affiliate_partner",
    status: "active",
  },
  membership: {
    membershipId: "membership_affiliate",
    status: "active",
    roleKey: "affiliate_owner",
    workosMembershipId: "om_affiliate",
    workosRoleSlugs: ["affiliate_owner"],
    permissions: ["affiliate.payout.manage"],
  },
  linkedResources: [
    {
      product: "affiliate",
      resourceType: "affiliate",
      resourceId: "affiliate_partner_bali",
      relationship: "owner",
      status: "active",
    },
  ],
  entitlements: [],
  locale: "en-US",
  currency: "USD",
  audit: {
    ...baseAudit,
    requestId: "req_affiliate",
  },
};

const platformContext: RequestContext = {
  actor: {
    internalUserId: "user_platform_admin",
    providerIdentity: {
      provider: "workos",
      providerUserId: "user_workos_platform",
      sessionId: "session_platform",
      providerOrganizationId: "org_workos_platform",
    },
    email: "admin@vayada.com",
    status: "active",
  },
  selectedOrganization: {
    organizationId: "org_platform",
    workosOrgId: "org_workos_platform",
    kind: "platform",
    status: "active",
  },
  membership: {
    membershipId: "membership_platform",
    status: "active",
    roleKey: "platform_admin",
    workosMembershipId: "om_platform",
    workosRoleSlugs: ["platform_admin"],
    permissions: [
      "platform.admin.read",
      "platform.finance.read",
      "platform.property.status.manage",
      "platform.user.suspend",
    ],
  },
  linkedResources: [
    {
      product: "platform",
      resourceType: "platform",
      resourceId: "vayada",
      relationship: "operator",
      status: "active",
    },
  ],
  entitlements: [],
  locale: "en-US",
  currency: "EUR",
  audit: {
    ...baseAudit,
    requestId: "req_platform",
  },
};

export const requestContextFixtureCases: RequestContextFixtureCase[] = [
  {
    name: "hotel owner can manage linked booking hotel settings",
    scope: "hotel",
    context: hotelOwnerContext,
    requirement: {
      permission: "booking.settings.manage",
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: "booking_hotel_alpenrose",
        allowedRelationships: ["owner"],
      },
    },
    expected: "allowed",
    reason:
      "active hotel-group membership has the permission and an owner link to the booking hotel",
  },
  {
    name: "hotel owner cannot update an unlinked PMS hotel",
    scope: "hotel",
    context: hotelOwnerContext,
    requirement: {
      permission: "pms.booking.update",
      resource: {
        product: "pms",
        resourceType: "pms_hotel",
        resourceId: "pms_hotel_other",
        allowedRelationships: ["operator"],
      },
    },
    expected: "denied",
    reason: "the permission alone is not enough without a linked resource",
  },
  {
    name: "creator can manage own marketplace profile",
    scope: "creator",
    context: creatorContext,
    requirement: {
      permission: "marketplace.profile.manage",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: "creator_profile_lina",
        allowedRelationships: ["owner"],
      },
    },
    expected: "allowed",
    reason: "active creator workspace owns the requested creator profile",
  },
  {
    name: "creator can read collaborations for own marketplace profile",
    scope: "creator",
    context: creatorContext,
    requirement: {
      permission: "marketplace.collaboration.read",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: "creator_profile_lina",
        allowedRelationships: ["owner"],
      },
    },
    expected: "allowed",
    reason:
      "active creator workspace has marketplace collaboration read permission and owns the creator profile",
  },
  {
    name: "hotel owner can read collaborations for linked marketplace listing",
    scope: "hotel",
    context: hotelOwnerContext,
    requirement: {
      permission: "marketplace.collaboration.read",
      resource: {
        product: "marketplace",
        resourceType: "marketplace_offer",
        resourceId: "marketplace_offer_alpenrose",
        allowedRelationships: ["owner", "operator"],
      },
    },
    expected: "allowed",
    reason:
      "active hotel-group membership has marketplace collaboration read permission and an operator link to the listing",
  },
  {
    name: "creator cannot review hotel collaborations without permission",
    scope: "creator",
    context: creatorContext,
    requirement: {
      permission: "marketplace.collaboration.review",
      resource: {
        product: "marketplace",
        resourceType: "marketplace_offer",
        resourceId: "marketplace_offer_alpenrose",
        allowedRelationships: ["owner"],
      },
    },
    expected: "denied",
    reason: "the creator workspace lacks both the hotel listing link and review permission",
  },
  {
    name: "affiliate can manage linked payout account",
    scope: "affiliate",
    context: affiliateContext,
    requirement: {
      permission: "affiliate.payout.manage",
      resource: {
        product: "affiliate",
        resourceType: "affiliate",
        resourceId: "affiliate_partner_bali",
        allowedRelationships: ["owner"],
      },
    },
    expected: "allowed",
    reason: "active affiliate-partner membership owns the affiliate resource",
  },
  {
    name: "affiliate cannot read hotel finance without finance permission",
    scope: "affiliate",
    context: affiliateContext,
    requirement: {
      permission: "pms.finance.read",
      resource: {
        product: "pms",
        resourceType: "pms_hotel",
        resourceId: "pms_hotel_alpenrose",
        allowedRelationships: ["owner", "operator"],
      },
    },
    expected: "denied",
    reason: "finance data needs a hotel resource link and explicit finance permission",
  },
  {
    name: "platform admin can read platform admin dashboards through platform scope",
    scope: "platform",
    context: platformContext,
    requirement: {
      permission: "platform.admin.read",
      resource: {
        product: "platform",
        resourceType: "platform",
        resourceId: "vayada",
        allowedRelationships: ["operator"],
      },
    },
    expected: "allowed",
    reason:
      "platform admin dashboard reads require platform organization membership, permission, and platform resource link",
  },
  {
    name: "platform admin can manage property status through platform scope",
    scope: "platform",
    context: platformContext,
    requirement: {
      permission: "platform.property.status.manage",
      resource: {
        product: "platform",
        resourceType: "platform",
        resourceId: "vayada",
        allowedRelationships: ["operator"],
      },
    },
    expected: "allowed",
    reason:
      "platform property moderation/status commands are platform-scoped rather than hotel-owner-scoped",
  },
  {
    name: "platform admin can suspend users through platform scope",
    scope: "platform",
    context: platformContext,
    requirement: {
      permission: "platform.user.suspend",
      resource: {
        product: "platform",
        resourceType: "platform",
        resourceId: "vayada",
        allowedRelationships: ["operator"],
      },
    },
    expected: "allowed",
    reason: "platform authorization comes from organization membership and permission",
  },
  {
    name: "platform admin cannot use platform role as hotel ownership",
    scope: "platform",
    context: platformContext,
    requirement: {
      permission: "booking.settings.manage",
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: "booking_hotel_alpenrose",
        allowedRelationships: ["owner"],
      },
    },
    expected: "denied",
    reason: "platform access is not an implicit hotel resource link",
  },
];
