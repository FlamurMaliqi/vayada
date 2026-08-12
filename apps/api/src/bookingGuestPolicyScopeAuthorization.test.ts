import { BOOKING_GUEST_POLICY_AUTHORIZATION } from "@vayada/domain-booking";
import { describe, expect, it, vi } from "vitest";

import { createPgBookingGuestPolicyScopeAuthorizationPort } from "./domains/bookingGuestPolicyScopeAuthorization.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";

describe("Booking guest-policy scope authorization", () => {
  it("checks the exact permission, entitlement, resource, and bounded query", async () => {
    const query = vi.fn(
      async (_request: { text: string; values: unknown[]; query_timeout: number }) => ({
        rows: [{ authorized: true }],
        rowCount: 1,
      }),
    );
    const port = createPgBookingGuestPolicyScopeAuthorizationPort({ pool: { query } as never });
    await expect(port.authorizeGuestPolicyScope(input())).resolves.toBe(true);
    const request = query.mock.calls[0]![0];
    expect(request.query_timeout).toBe(5_000);
    expect(request.text).toContain("permission_grant.permission_key = $4");
    expect(request.text).toContain("entitlement.status = 'suspended'");
    expect(request.values).toEqual([
      organizationId,
      propertyId,
      actorUserId,
      BOOKING_GUEST_POLICY_AUTHORIZATION.permission,
      BOOKING_GUEST_POLICY_AUTHORIZATION.entitlement.product,
      BOOKING_GUEST_POLICY_AUTHORIZATION.entitlement.key,
      BOOKING_GUEST_POLICY_AUTHORIZATION.resource.product,
      BOOKING_GUEST_POLICY_AUTHORIZATION.resource.resourceType,
      [...BOOKING_GUEST_POLICY_AUTHORIZATION.resource.allowedRelationships],
      "2026-08-05T13:00:00.000Z",
    ]);
  });

  it("fails closed before SQL for malformed scope and on provider failure", async () => {
    const query = vi.fn(async (_request: unknown) => {
      throw new Error("unavailable");
    });
    const port = createPgBookingGuestPolicyScopeAuthorizationPort({ pool: { query } as never });
    await expect(
      port.authorizeGuestPolicyScope({ ...input(), propertyId: "not-a-uuid" }),
    ).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
    await expect(port.authorizeGuestPolicyScope(input())).resolves.toBe(false);
  });

  it("fails closed for mismatched authorization metadata and timestamps", async () => {
    const query = vi.fn(async () => ({ rows: [{ authorized: true }], rowCount: 1 }));
    const port = createPgBookingGuestPolicyScopeAuthorizationPort({ pool: { query } as never });
    const rejected = [
      { ...input(), permission: "booking.settings.read" },
      { ...input(), entitlement: { ...input().entitlement, key: "other-key" } },
      { ...input(), resource: { ...input().resource, resourceType: "other_type" } },
      { ...input(), resource: { ...input().resource, allowedRelationships: [] } },
      { ...input(), checkedAt: "2026-08-05T13:00:00Z" },
      { ...input(), checkedAt: "not-a-timestamp" },
    ];

    for (const candidate of rejected) {
      await expect(port.authorizeGuestPolicyScope(candidate as never)).resolves.toBe(false);
    }
    expect(query).not.toHaveBeenCalled();
  });
});

function input() {
  return {
    organizationId,
    propertyId,
    actorUserId,
    permission: BOOKING_GUEST_POLICY_AUTHORIZATION.permission,
    entitlement: BOOKING_GUEST_POLICY_AUTHORIZATION.entitlement,
    resource: BOOKING_GUEST_POLICY_AUTHORIZATION.resource,
    checkedAt: "2026-08-05T13:00:00.000Z",
  };
}
