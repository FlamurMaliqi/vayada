import type { APIRequestContext } from "@playwright/test";

import { waitForNoPublicOffer, type BookingResource, type Stay } from "./booking-lifecycle";
import {
  publicApi,
  workosApi,
  workosOrganizationsForUser,
  workosUserIdsForEmail,
  type JsonApi,
  type SmokeEnvironment,
  type SyntheticUser,
} from "./support";

export type HotelResource = {
  api: JsonApi;
  addonItemIds?: string[];
  propertyId: string;
  slug?: string;
  stay?: Stay;
};

export async function cleanupSmokeResources(
  request: APIRequestContext,
  environment: SmokeEnvironment,
  users: SyntheticUser[],
  bookings: BookingResource[],
  hotel?: HotelResource,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  const publicClient = publicApi(request);
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
      if (!hotel) {
        errors.push(error);
        continue;
      }
      try {
        await hotel.api.json(
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
    for (const addonItemId of hotel.addonItemIds ?? []) {
      try {
        await hotel.api.json(
          "DELETE",
          `/api/booking/hotels/${hotel.propertyId}/addon-items/${addonItemId}`,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await hotel.api.json(
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

  const workos = workosApi(request, environment.workosApiKey);
  const userIds = new Set(users.map(({ id }) => id));
  const userRoles = new Map(users.map(({ id, role }) => [id, role]));
  for (const role of ["hotel", "creator"] as const) {
    try {
      const email = `qa-next-${role}-${environment.runId}@${environment.emailDomain}`;
      for (const userId of await workosUserIdsForEmail(request, environment.workosApiKey, email)) {
        userIds.add(userId);
        userRoles.set(userId, role);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  const organizations = new Map<string, { role: "hotel" | "creator"; userId: string }>();
  for (const userId of userIds) {
    try {
      const role = userRoles.get(userId);
      if (!role) throw new Error(`Synthetic WorkOS user ${userId} has no expected role.`);
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
  for (const userId of [...userIds].reverse()) {
    try {
      await workos.deleteIfPresent(`/user_management/users/${encodeURIComponent(userId)}`);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
