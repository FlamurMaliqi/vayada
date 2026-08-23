import { describe, expect, it } from "vitest";

import {
  identityLifecycleCommandTypes,
  identityLifecycleEventTypes,
  identityLifecycleIdempotencyScope,
  membershipPropertyAccessModeForProvisioning,
  type CreateAffiliateInviteCommand,
  type CreateCustomerInviteCommand,
  type CreateIdentityRecoveryFlowCommand,
  type CreateIdentityRecoveryFlowPayload,
  type CreateIdentityUserCommand,
  type GrantIdentityAccessCommand,
  type GrantIdentityResourceLinksCommand,
  type IdentityCommandAudit,
  type IdentityLifecycleEvent,
  type RevokeIdentityAccessCommand,
} from "./lifecycle.js";

const audit: IdentityCommandAudit = {
  actor: {
    kind: "user",
    userId: "platform_admin_001",
    organizationId: "platform_org_001",
  },
  source: "admin",
  requestId: "req_001",
  reason: "VAY-656 contract fixture",
  requestedAt: "2026-06-07T10:00:00.000Z",
};

describe("identity lifecycle command contract", () => {
  it("provisions broad property scope only for hotel owner roles", () => {
    expect(membershipPropertyAccessModeForProvisioning("hotel_group", "hotel_owner")).toBe("all");
    expect(membershipPropertyAccessModeForProvisioning("hotel_group", "owner")).toBe("all");
    expect(membershipPropertyAccessModeForProvisioning("hotel_group", "operator")).toBe("all");
    expect(membershipPropertyAccessModeForProvisioning("hotel_group", "front_desk")).toBe(
      "assigned",
    );
    expect(membershipPropertyAccessModeForProvisioning("creator_workspace", "creator_owner")).toBe(
      "assigned",
    );
  });

  it("catalogs the VAY-656 user lifecycle command surface", () => {
    expect(identityLifecycleCommandTypes).toEqual([
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
    ]);

    expect(identityLifecycleEventTypes).toEqual([
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
    ]);
  });

  it("scopes idempotency by command type", () => {
    const createUser: CreateIdentityUserCommand = {
      commandType: "identity.user.create",
      commandId: "cmd_create_001",
      idempotencyKey: "booking-register-owner@example.com",
      audit,
      payload: {
        email: "owner@example.com",
        name: "Owner Example",
        initialStatus: "pending",
        organization: {
          kind: "hotel_group",
          name: "Alpenrose Hotel Group",
        },
        membership: {
          roleKey: "hotel_owner",
          propertyAccessMode: "all",
          permissionKeys: ["booking.settings.manage"],
        },
        resourceLinks: [
          {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
            relationship: "owner",
          },
        ],
      },
    };

    const recovery: CreateIdentityRecoveryFlowCommand = {
      commandType: "identity.recovery.flow.create",
      commandId: "cmd_recovery_001",
      idempotencyKey: "booking-register-owner@example.com",
      audit,
      payload: {
        flowKind: "password_reset",
        email: "owner@example.com",
      },
    };

    expect(identityLifecycleIdempotencyScope(createUser)).toBe(
      "identity.user.create:booking-register-owner@example.com",
    );
    expect(identityLifecycleIdempotencyScope(recovery)).toBe(
      "identity.recovery.flow.create:booking-register-owner@example.com",
    );
  });

  it("requires recovery commands to identify a target", () => {
    const resetByEmail: CreateIdentityRecoveryFlowPayload = {
      flowKind: "password_reset",
      email: "owner@example.com",
    };
    const emailChange: CreateIdentityRecoveryFlowPayload = {
      flowKind: "email_change",
      userId: "user_001",
      newEmail: "new-owner@example.com",
    };

    expect(resetByEmail.email).toBe("owner@example.com");
    expect(emailChange.newEmail).toBe("new-owner@example.com");

    // @ts-expect-error email changes require the requested new email.
    const invalidEmailChange: CreateIdentityRecoveryFlowPayload = {
      flowKind: "email_change",
      userId: "user_001",
    };

    expect(invalidEmailChange.flowKind).toBe("email_change");
  });

  it("models affiliate invites as organization membership and resource-link ownership", () => {
    const command: CreateAffiliateInviteCommand = {
      commandType: "identity.invite.affiliate.create",
      commandId: "cmd_affiliate_invite_001",
      idempotencyKey: "affiliate:affiliate_001:approved",
      audit,
      payload: {
        email: "partner@example.com",
        name: "Partner Example",
        organization: {
          organizationId: "affiliate_org_001",
          kind: "affiliate_partner",
          name: "Partner Example",
        },
        membership: {
          roleKey: "affiliate_owner",
          propertyAccessMode: "assigned",
          permissionKeys: ["affiliate.payout.manage"],
        },
        affiliateResourceLink: {
          organizationId: "affiliate_org_001",
          product: "affiliate",
          resourceType: "affiliate",
          resourceId: "affiliate_001",
          relationship: "owner",
        },
      },
    };

    expect(command.payload.membership.roleKey).toBe("affiliate_owner");
    expect(command.payload.affiliateResourceLink.resourceType).toBe("affiliate");
  });

  it("models existing-user access grants through membership, resource links, and permissions", () => {
    const command: GrantIdentityAccessCommand = {
      commandType: "identity.access.grant",
      commandId: "cmd_access_grant_001",
      idempotencyKey: "platform:user_001:superadmin:true",
      audit,
      payload: {
        userId: "user_001",
        organization: {
          organizationId: "platform_org_001",
          kind: "platform",
          name: "Vayada Platform",
        },
        membership: {
          roleKey: "platform_admin",
          propertyAccessMode: "assigned",
          permissionKeys: ["platform.user.suspend"],
        },
        resourceLinks: [
          {
            organizationId: "platform_org_001",
            product: "platform",
            resourceType: "platform",
            resourceId: "platform",
            relationship: "operator",
          },
        ],
        permissionGrants: [
          {
            organizationKind: "platform",
            roleKey: "platform_admin",
            permissionKey: "platform.user.suspend",
          },
        ],
      },
    };

    expect(command.payload.membership.permissionKeys).toEqual(["platform.user.suspend"]);
    expect(command.payload.resourceLinks?.[0].relationship).toBe("operator");
  });

  it("models access revocation with a resource-link relationship target", () => {
    const command: RevokeIdentityAccessCommand = {
      commandType: "identity.access.revoke",
      commandId: "cmd_access_revoke_001",
      idempotencyKey: "platform:user_001:superadmin:false",
      audit,
      payload: {
        userId: "user_001",
        organizationId: "platform_org_001",
        membershipStatus: "inactive",
        resourceLinks: [
          {
            product: "platform",
            resourceType: "platform",
            resourceId: "platform",
            relationship: "operator",
            status: "archived",
          },
        ],
        permissionGrants: [
          {
            organizationKind: "platform",
            roleKey: "platform_admin",
            permissionKey: "platform.user.suspend",
          },
        ],
      },
    };

    expect(command.payload.resourceLinks?.[0].relationship).toBe("operator");
    expect(command.payload.resourceLinks?.[0].status).toBe("archived");
  });

  it("models resource-link grants without organization or membership mutation inputs", () => {
    const command: GrantIdentityResourceLinksCommand = {
      commandType: "identity.resource_links.grant",
      commandId: "cmd_resource_link_grant_001",
      idempotencyKey: "marketplace:offer_001:owner",
      audit,
      payload: {
        organizationId: "hotel_org_001",
        resourceLinks: [
          {
            product: "marketplace",
            resourceType: "marketplace_offer",
            resourceId: "offer_001",
            relationship: "owner",
          },
        ],
      },
    };

    expect(command.payload).toEqual({
      organizationId: "hotel_org_001",
      resourceLinks: [
        {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: "offer_001",
          relationship: "owner",
        },
      ],
    });
  });

  it("keeps customer invites separate from product resource ownership", () => {
    const command: CreateCustomerInviteCommand = {
      commandType: "identity.invite.customer.create",
      commandId: "cmd_customer_invite_001",
      idempotencyKey: "booking:guest_booking_001:customer-invite",
      audit,
      payload: {
        email: "guest@example.com",
        bookingReference: {
          bookingId: "guest_booking_001",
          hotelResource: {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
          },
        },
      },
    };

    expect(command.payload.bookingReference?.bookingId).toBe("guest_booking_001");
  });

  it("models privacy-owned cookie consent and GDPR requests", () => {
    expect(
      identityLifecycleIdempotencyScope({
        commandType: "identity.consent.cookie.upsert",
        commandId: "cmd_cookie_001",
        idempotencyKey: "visitor:visitor_001:cookie-consent",
        audit: { ...audit, source: "web" },
        payload: {
          visitorId: "visitor_001",
          necessary: true,
          functional: true,
          analytics: false,
          marketing: false,
        },
      }),
    ).toBe("identity.consent.cookie.upsert:visitor:visitor_001:cookie-consent");

    const deletionEvent: IdentityLifecycleEvent = {
      eventType: "identity.gdpr.deletion.requested",
      eventId: "evt_gdpr_delete_001",
      commandId: "cmd_gdpr_delete_001",
      idempotencyKey: "gdpr:user_001:deletion:pending",
      userId: "user_001",
      occurredAt: "2026-06-07T10:02:00.000Z",
      audit,
      payload: {
        userId: "user_001",
        requestId: "gdpr_request_001",
        scheduledDeletionAt: "2026-07-07T10:02:00.000Z",
      },
    };

    expect(deletionEvent.payload.scheduledDeletionAt).toBe("2026-07-07T10:02:00.000Z");
  });

  it("carries event-specific payloads for product consumers", () => {
    const event: IdentityLifecycleEvent = {
      eventType: "identity.user.email.updated",
      eventId: "evt_email_updated_001",
      commandId: "cmd_email_update_001",
      idempotencyKey: "user:user_001:email:new-owner@example.com",
      userId: "user_001",
      occurredAt: "2026-06-07T10:01:00.000Z",
      audit,
      payload: {
        userId: "user_001",
        email: "new-owner@example.com",
        providerEmailVerified: true,
      },
    };

    if (event.eventType !== "identity.user.email.updated") {
      throw new Error("Unexpected test event");
    }

    expect(event.payload.email).toBe("new-owner@example.com");
  });
});
