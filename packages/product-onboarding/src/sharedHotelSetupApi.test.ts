import type { AdaptiveHotelSetupStatus, UpdateTracksResponse } from "@vayada/domain-hotels";
import { describe, expect, it } from "vitest";

import { createSharedHotelSetupApi, type SharedHotelSetupHttpClient } from "./sharedHotelSetupApi";

describe("createSharedHotelSetupApi", () => {
  const handoffCode = "7_8FkqvJvK_vOS5Ke4iFAScHY6LmDsQUviRLKfS1dCk";

  it("parses the adaptive status contract and rejects an obsolete response", async () => {
    const validApi = createSharedHotelSetupApi(clientReturning(validStatus()));
    const invalidApi = createSharedHotelSetupApi(
      clientReturning({ contractVersion: "obsolete-contract.v1" }),
    );

    await expect(validApi.getStatus({ entryProduct: "booking" })).resolves.toMatchObject({
      contractVersion: "adaptive-hotel-setup.v1",
    });
    await expect(invalidApi.getStatus()).rejects.toThrow("Hotel setup data is invalid");
  });

  it("sends one caller-provided idempotency key on track and property retries", async () => {
    const putCalls: Array<{ endpoint: string; data: unknown; options?: RequestInit }> = [];
    const postCalls: Array<{ endpoint: string; data: unknown; options?: RequestInit }> = [];
    const client: SharedHotelSetupHttpClient = {
      get: async <T>() => validStatus() as T,
      put: async <T>(endpoint: string, data?: unknown, options?: RequestInit) => {
        putCalls.push({ endpoint, data, options });
        if (endpoint.endsWith("/public-profile")) return validPublicProfile() as T;
        if (endpoint.endsWith("/profile")) return validProfile() as T;
        return {
          trackRevision: 1,
          selectedTracks: ["hotel_operations"],
          tracks: validStatus().organization.tracks,
        } as UpdateTracksResponse as T;
      },
      post: async <T>(endpoint: string, data?: unknown, options?: RequestInit) => {
        postCalls.push({ endpoint, data, options });
        return validProfile() as T;
      },
    };
    const api = createSharedHotelSetupApi(client);
    const retryKey = "same-command-key";
    const update = { selectedTracks: ["hotel_operations"] as const, expectedRevision: 0 };

    await api.updateTracks({ ...update, selectedTracks: [...update.selectedTracks] }, retryKey);
    await api.updateTracks({ ...update, selectedTracks: [...update.selectedTracks] }, retryKey);
    await api.createPropertyProfile({} as never, retryKey);
    await api.createPropertyProfile({} as never, retryKey);
    await api.updatePropertyProfile("property-1", {
      expectedProfileRevision: 1,
      patch: { displayName: "Hotel Alpenrose" },
    });
    await api.updatePublicPropertyProfile("property-1", {
      expectedProfileRevision: 1,
      patch: { shortDescription: "A city hotel." },
    });

    expect(putCalls.map(({ endpoint }) => endpoint)).toEqual([
      "/api/hotel-setup/tracks",
      "/api/hotel-setup/tracks",
      "/api/hotel-setup/properties/property-1/profile",
      "/api/hotel-setup/properties/property-1/public-profile",
    ]);
    expect(postCalls.map(({ endpoint }) => endpoint)).toEqual([
      "/api/hotel-setup/properties",
      "/api/hotel-setup/properties",
    ]);
    for (const call of [...putCalls.slice(0, 2), ...postCalls]) {
      expect(call.options?.headers).toEqual({ "Idempotency-Key": retryKey });
    }
    expect(putCalls[2]?.data).toEqual({
      expectedProfileRevision: 1,
      patch: { displayName: "Hotel Alpenrose" },
    });
    expect(putCalls[3]?.data).toEqual({
      expectedProfileRevision: 1,
      patch: { shortDescription: "A city hotel." },
    });
  });

  it("parses the separate public description and approved-media profile", async () => {
    const client = clientReturning(validPublicProfile());
    const api = createSharedHotelSetupApi(client);

    await expect(api.getPublicPropertyProfile("property-1")).resolves.toEqual(validPublicProfile());
  });

  it("creates and exchanges the exact server-validated handoff wire", async () => {
    const calls: Array<{ endpoint: string; data: unknown }> = [];
    const client: SharedHotelSetupHttpClient = {
      get: async <T>() => validStatus() as T,
      put: async <T>() => validStatus() as T,
      post: async <T>(endpoint: string, data?: unknown) => {
        calls.push({ endpoint, data });
        return (
          endpoint.endsWith("/exchange")
            ? {
                propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                taskId: "guest_settings_policies",
                issuedPlanRevision: "tracks:1|guest_settings_policies:revision-1:fresh",
                destinationRouteKey: "booking.guest_settings_policies",
                returnUrl:
                  "https://marketplace.vayada.com/setup?propertyId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              }
            : {
                launchUrl: `https://admin.booking.vayada.com/handoff?code=${handoffCode}`,
                expiresAt: "2026-07-26T18:05:00.000Z",
              }
        ) as T;
      },
    };
    const api = createSharedHotelSetupApi(client);
    const createRequest = {
      propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      taskId: "guest_settings_policies" as const,
      planRevision: "tracks:1|guest_settings_policies:revision-1:fresh",
    };

    await expect(api.createHandoff(createRequest)).resolves.toEqual({
      launchUrl: `https://admin.booking.vayada.com/handoff?code=${handoffCode}`,
      expiresAt: "2026-07-26T18:05:00.000Z",
    });
    await expect(api.exchangeHandoff({ code: handoffCode })).resolves.toMatchObject({
      propertyId: createRequest.propertyId,
      destinationRouteKey: "booking.guest_settings_policies",
    });
    expect(calls).toEqual([
      { endpoint: "/api/hotel-setup/handoffs", data: createRequest },
      { endpoint: "/api/hotel-setup/handoffs/exchange", data: { code: handoffCode } },
    ]);
  });

  it("rejects client-added routes and malformed handoff responses", async () => {
    const api = createSharedHotelSetupApi(
      clientReturning({
        launchUrl:
          "https://admin.booking.vayada.com/handoff?code=7_8FkqvJvK_vOS5Ke4iFAScHY6LmDsQUviRLKfS1dCk&propertyId=secret",
        expiresAt: "2026-07-26T18:05:00.000Z",
      }),
    );

    await expect(
      api.createHandoff({
        propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        taskId: "guest_settings_policies",
        planRevision: "tracks:1",
        destinationRoute: "https://attacker.example/handoff",
      } as never),
    ).rejects.toThrow("handoff request is invalid");
    await expect(
      api.createHandoff({
        propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        taskId: "guest_settings_policies",
        planRevision: "tracks:1",
      }),
    ).rejects.toThrow("handoff data is invalid");
  });
});

function clientReturning(value: unknown): SharedHotelSetupHttpClient {
  return {
    get: async <T>() => value as T,
    post: async <T>() => value as T,
    put: async <T>() => value as T,
  };
}

function validProfile() {
  return {
    propertyId: "property-1",
    profileRevision: 1,
    profile: {
      displayName: "Hotel Alpenrose",
      propertyType: "hotel",
      location: {
        streetAddress: "Marienplatz 1",
        postalCode: "80331",
        city: "Munich",
        countryCode: "DE",
        timezone: "Europe/Berlin",
        latitude: null,
        longitude: null,
        localityPublic: false,
        geoPublic: false,
        mapDisplayMode: "hidden",
      },
      contacts: [
        {
          channelType: "email",
          value: "hello@alpenrose.example",
          purpose: "general",
          isPublic: false,
        },
        {
          channelType: "phone",
          value: "+49 89 123456",
          purpose: "general",
          isPublic: false,
        },
      ],
    },
  } as const;
}

function validPublicProfile() {
  return {
    propertyId: "property-1",
    profileRevision: 2,
    publicProfile: {
      locale: "en",
      shortDescription: "A city hotel.",
      longDescription: null,
      media: [],
    },
  } as const;
}

function validStatus(): AdaptiveHotelSetupStatus {
  return {
    contractVersion: "adaptive-hotel-setup.v1",
    organization: {
      organizationId: "organization-1",
      displayName: "Alpenrose Group",
      websiteUrl: null,
      selectedTracks: [],
      trackRevision: 0,
      canManageTracks: true,
      tracks: [
        {
          track: "hotel_operations",
          provisioning: "not_selected",
          components: [
            { product: "pms", access: "absent" },
            { product: "booking", access: "absent" },
          ],
          allowedActions: ["add"],
        },
        {
          track: "creator_marketplace",
          provisioning: "not_selected",
          components: [{ product: "marketplace", access: "absent" }],
          allowedActions: ["add"],
        },
      ],
    },
    propertySelection: {
      state: "no_property",
      selectedPropertyId: null,
      availableProperties: [],
    },
    entryDecision: {
      requestedProduct: "booking",
      propertyId: null,
      decision: "setup_required",
      destinationRouteKey: "hotel_setup",
      reasonCode: "track_not_selected",
    },
    setupPlan: null,
    updatedAt: "2026-07-26T12:00:00.000Z",
  };
}
