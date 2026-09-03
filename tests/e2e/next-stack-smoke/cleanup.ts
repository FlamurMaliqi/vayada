import type { APIRequestContext } from "@playwright/test";

import { waitForNoPublicOffer, type BookingResource, type Stay } from "./booking-lifecycle";
import {
  arrayField,
  authenticateSyntheticPmsUser,
  authenticateSyntheticPlatformAdmin,
  createSyntheticPlatformAdmin,
  numberField,
  publicApi,
  record,
  smokeRecoveryReceipt,
  stringField,
  targetApi,
  workosApi,
  workosMembershipIdsForUser,
  workosOrganizationsForUser,
  workosUserIdsForEmail,
  syntheticPlatformAdminEmail,
  type JsonApi,
  type SmokeEnvironment,
  type SyntheticPlatformAdmin,
  type SyntheticUser,
} from "./support";

export type HotelResource = {
  api: JsonApi;
  addonItemIds?: string[];
  ownerWorkosUserId?: string;
  propertyId: string;
  slug?: string;
  stay?: Stay;
  workosOrganizationId?: string;
};

export async function cleanupSmokeResources(
  request: APIRequestContext,
  environment: SmokeEnvironment,
  users: SyntheticUser[],
  bookings: BookingResource[],
  hotel?: HotelResource,
  platformAdmin?: SyntheticPlatformAdmin,
  retirementPropertyIds: string[] = [],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  const publicClient = publicApi(request);
  let hotelApi = hotel?.api;
  if (hotel?.ownerWorkosUserId) {
    try {
      const owner = users.find(({ id }) => id === hotel.ownerWorkosUserId);
      if (!owner) throw new Error("Synthetic hotel owner could not be found for cleanup.");
      hotelApi = targetApi(
        request,
        await authenticateSyntheticPmsUser(request, owner, environment.password),
      );
    } catch (error) {
      errors.push(error);
    }
  }
  for (const booking of bookings.filter(({ resolved }) => !resolved).reverse()) {
    try {
      const action = booking.mode === "request" ? "withdraw" : "cancel";
      await publicClient.json(
        "POST",
        `/api/booking-web/hotels/${booking.slug}/bookings/${booking.bookingId}/${action}`,
        { guestEmail: booking.email },
      );
      booking.resolved = true;
    } catch (error) {
      if (!hotel || !hotelApi) {
        errors.push(error);
        continue;
      }
      try {
        await hotelApi.json(
          "POST",
          `/api/pms/properties/${hotel.propertyId}/reservations/${booking.bookingId}/cancel`,
          {
            commandId: `next-smoke:${environment.runId}:cleanup-booking:${booking.bookingId}`,
            idempotencyKey: `next-smoke:${environment.runId}:cleanup-booking:${booking.bookingId}`,
            reason: "Automated next-stack smoke cleanup",
            accountingDate: null,
            retainedCharges: [],
          },
        );
        booking.resolved = true;
      } catch (fallbackError) {
        errors.push(new AggregateError([error, fallbackError], "Booking cleanup failed."));
      }
    }
  }

  if (hotel) {
    const api = hotelApi ?? hotel.api;
    for (const addonItemId of hotel.addonItemIds ?? []) {
      try {
        await api.json(
          "DELETE",
          `/api/booking/hotels/${hotel.propertyId}/addon-items/${addonItemId}`,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await api.json(
        "PATCH",
        `/api/finance/properties/${hotel.propertyId}/payment-settings`,
        {
          commandId: `next-smoke:${environment.runId}:cleanup-payment`,
          idempotencyKey: `next-smoke:${environment.runId}:cleanup-payment`,
          paymentSettings: {
            paymentsEnabled: true,
            paymentProvider: "manual",
            acceptedMethods: ["other"],
          },
        },
      );
      if (hotel.slug && hotel.stay) {
        await waitForNoPublicOffer(request, hotel.slug, hotel.stay);
      }
    } catch (error) {
      errors.push(error);
    }
  }

  for (const propertyId of new Set(retirementPropertyIds)) {
    try {
      if (!platformAdmin) throw new Error("Synthetic Platform Admin was not created.");
      await recoverSyntheticSmokeBookings(
        request,
        environment,
        platformAdmin,
        environment.runId,
        propertyId,
        smokeRecoveryReceipt(environment, environment.runId, propertyId),
      );
      await retireSmokeProperty(request, environment, platformAdmin, propertyId);
    } catch (error) {
      errors.push(error);
      errors.push(
        new Error(
          `Recovery required: recovery_run_id=${environment.runId} recovery_property_id=${propertyId} recovery_receipt=${smokeRecoveryReceipt(environment, environment.runId, propertyId)}`,
        ),
      );
    }
  }

  const workos = workosApi(request, environment.workosApiKey);
  const userRoles = new Map(users.map(({ id, role }) => [id, role]));
  for (const [role, qualifier] of [
    ["hotel", ""],
    ["hotel", "foreign-"],
    ["creator", ""],
    ["staff", ""],
  ] as const) {
    try {
      const email = `qa-next-${qualifier}${role}-${environment.runId}@${environment.emailDomain}`;
      for (const userId of await workosUserIdsForEmail(request, environment.workosApiKey, email)) {
        userRoles.set(userId, role);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  const staffUserIds = [...userRoles]
    .filter(([, role]) => role === "staff")
    .map(([userId]) => userId);
  if (staffUserIds.length > 1) {
    errors.push(new Error("Refusing to delete duplicate synthetic staff users."));
    for (const userId of staffUserIds) userRoles.delete(userId);
  }
  for (const userId of staffUserIds.length === 1 ? staffUserIds : []) {
    try {
      if (!hotel?.workosOrganizationId || !hotel.ownerWorkosUserId) {
        throw new Error("Synthetic staff organization ownership could not be proven.");
      }
      const email = `qa-next-staff-${environment.runId}@${environment.emailDomain}`;
      const invitationResponse = await workos.json<Record<string, unknown>>(
        "GET",
        `/user_management/invitations?email=${encodeURIComponent(email)}&organization_id=${encodeURIComponent(hotel.workosOrganizationId)}&limit=100`,
      );
      const invitations = arrayField(invitationResponse, "data").map(record);
      if (
        invitations.length > 1 ||
        invitations.some(
          (invitation) =>
            invitation.email !== email ||
            invitation.organization_id !== hotel.workosOrganizationId ||
            invitation.inviter_user_id !== hotel.ownerWorkosUserId ||
            invitation.role_slug !== "hotel_member",
        )
      ) {
        throw new Error("Refusing to revoke an unexpected synthetic staff invitation.");
      }
      const pendingInvitation = invitations.find(({ state }) => state === "pending");
      if (pendingInvitation) {
        const revoked = await workos.json<Record<string, unknown>>(
          "POST",
          `/user_management/invitations/${encodeURIComponent(stringField(pendingInvitation, "id"))}/revoke`,
        );
        if (revoked.state !== "revoked") throw new Error("Staff invitation revocation failed.");
      }
      const membershipResponse = await workos.json<Record<string, unknown>>(
        "GET",
        `/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}&statuses=active,pending,inactive&limit=100`,
      );
      const memberships = arrayField(membershipResponse, "data").map(record);
      if (
        memberships.length > 1 ||
        memberships.some(
          (membership) =>
            membership.user_id !== userId ||
            membership.organization_id !== hotel.workosOrganizationId,
        )
      ) {
        throw new Error("Refusing to delete an unexpected synthetic staff membership.");
      }
      for (const membership of memberships) {
        await workos.deleteIfPresent(
          `/user_management/organization_memberships/${encodeURIComponent(stringField(membership, "id"))}`,
        );
      }
    } catch (error) {
      errors.push(error);
      userRoles.delete(userId);
    }
  }
  const organizations = new Map<string, { role: "hotel" | "creator"; userId: string }>();
  for (const [userId, role] of userRoles) {
    if (role === "staff") continue;
    try {
      for (const organizationId of await workosOrganizationsForUser(
        request,
        environment.workosApiKey,
        userId,
      )) {
        organizations.set(organizationId, { role, userId });
      }
    } catch (error) {
      errors.push(error);
    }
  }
  for (const [organizationId, owner] of [...organizations].reverse()) {
    try {
      const organization = await workos.json<Record<string, unknown>>(
        "GET",
        `/organizations/${encodeURIComponent(organizationId)}`,
      );
      const expectedExternalId = `vayada-signup:marketplace-web:${owner.role}:${owner.userId}`;
      const metadata = organization.metadata;
      const expectedKind = owner.role === "hotel" ? "hotel_group" : "creator_workspace";
      if (
        organization.external_id !== expectedExternalId ||
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        (metadata as Record<string, unknown>).auth_flow !== "signup" ||
        (metadata as Record<string, unknown>).surface !== "marketplace-web" ||
        (metadata as Record<string, unknown>).signup_intent !== owner.role ||
        (metadata as Record<string, unknown>).organization_kind !== expectedKind
      ) {
        throw new Error(
          `Refusing to delete WorkOS organization ${organizationId}: synthetic ownership could not be proven.`,
        );
      }
      await workos.deleteIfPresent(`/organizations/${encodeURIComponent(organizationId)}`);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    const deleted = await deleteSyntheticPlatformAdmin(
      request,
      environment,
      workos,
      environment.runId,
    );
    if (platformAdmin && deleted !== 1) {
      throw new Error(`Expected one temporary Platform Admin, found ${deleted}.`);
    }
  } catch (error) {
    errors.push(error);
  }
  for (const userId of [...userRoles.keys()].reverse()) {
    try {
      await workos.deleteIfPresent(`/user_management/users/${encodeURIComponent(userId)}`);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export async function recoverSmokeProperty(
  request: APIRequestContext,
  environment: SmokeEnvironment,
  failedRunId: string,
  propertyId: string,
): Promise<void> {
  const workos = workosApi(request, environment.workosApiKey);
  const errors: unknown[] = [];
  let recoveryAdmin: SyntheticPlatformAdmin | undefined;
  try {
    await deleteSyntheticPlatformAdmin(request, environment, workos, failedRunId);
    recoveryAdmin = await createSyntheticPlatformAdmin(request, environment, failedRunId);
    if (!environment.recoveryReceipt) throw new Error("Synthetic recovery receipt is missing.");
    await recoverSyntheticSmokeBookings(
      request,
      environment,
      recoveryAdmin,
      failedRunId,
      propertyId,
      environment.recoveryReceipt,
    );
    await retireSmokeProperty(request, environment, recoveryAdmin, propertyId);
  } catch (error) {
    errors.push(error);
  }
  try {
    const deleted = await deleteSyntheticPlatformAdmin(request, environment, workos, failedRunId);
    if (recoveryAdmin && deleted !== 1) {
      throw new Error(`Expected one recovery Platform Admin, found ${deleted}.`);
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `Recovery failed for synthetic property ${propertyId}.`);
  }
}

async function recoverSyntheticSmokeBookings(
  request: APIRequestContext,
  environment: SmokeEnvironment,
  platformAdmin: SyntheticPlatformAdmin,
  runId: string,
  propertyId: string,
  recoveryReceipt: string,
): Promise<void> {
  await targetApi(
    request,
    await authenticateSyntheticPlatformAdmin(request, platformAdmin, environment.password),
  ).json("POST", "/api/platform/admin/bookings/recover-next-stack-smoke", {
    emailDomain: environment.emailDomain,
    propertyId,
    recoveryReceipt,
    runId,
  });
}

async function retireSmokeProperty(
  request: APIRequestContext,
  environment: SmokeEnvironment,
  platformAdmin: SyntheticPlatformAdmin,
  propertyId: string,
): Promise<void> {
  const platformAdminApi = targetApi(
    request,
    await authenticateSyntheticPlatformAdmin(request, platformAdmin, environment.password),
  );
  const impact = await platformAdminApi.json<Record<string, unknown>>(
    "GET",
    `/api/platform/admin/properties/${propertyId}/retirement-impact`,
  );
  if (impact.lifecycleStatus === "retired") return;
  const retirement = await platformAdminApi.json<Record<string, unknown>>(
    "POST",
    `/api/platform/admin/properties/${propertyId}/retire`,
    {
      expectedLifecycleRevision: numberField(impact, "lifecycleRevision"),
      confirmation: "RETIRE",
      reason: "Retire the isolated next-stack smoke property",
    },
    { "Idempotency-Key": `next-smoke:${environment.runId}:property-retired:${propertyId}` },
  );
  if (retirement.lifecycleStatus !== "retired") {
    throw new Error("Synthetic property retirement was not confirmed.");
  }
}

async function deleteSyntheticPlatformAdmin(
  request: APIRequestContext,
  environment: SmokeEnvironment,
  workos: JsonApi,
  runId: string,
): Promise<number> {
  const email = syntheticPlatformAdminEmail(environment, runId);
  try {
    const userIds = await workosUserIdsForEmail(request, environment.workosApiKey, email);
    for (const userId of userIds) {
      for (const membershipId of await workosMembershipIdsForUser(
        request,
        environment.workosApiKey,
        userId,
      )) {
        await workos.deleteIfPresent(
          `/user_management/organization_memberships/${encodeURIComponent(membershipId)}`,
        );
      }
      await workos.deleteIfPresent(`/user_management/users/${encodeURIComponent(userId)}`);
    }
    const remaining = await workosUserIdsForEmail(request, environment.workosApiKey, email);
    if (remaining.length) throw new Error("Deletion was not confirmed.");
    return userIds.length;
  } catch (error) {
    throw new AggregateError(
      [error],
      `Temporary Platform Admin cleanup failed: admin_run_id=${runId} admin_email=${email}`,
    );
  }
}
