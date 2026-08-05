import type { AdaptiveHotelSetupStatus, UpdateTracksResponse } from "@vayada/domain-hotels";
import { describe, expect, it } from "vitest";

import { createSharedHotelSetupApi, type SharedHotelSetupHttpClient } from "./sharedHotelSetupApi";

describe("createSharedHotelSetupApi", () => {
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

  it("sends and validates a revision-guarded property presentation command", async () => {
    const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const mediaObjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const calls: Array<{ endpoint: string; data: unknown; options?: RequestInit }> = [];
    const response = {
      outcome: "updated",
      profileRevision: 8,
      logoAssignment: null,
      presentationAssignments: [{ mediaObjectId, role: "cover", altText: null, sortOrder: 0 }],
    } as const;
    const client: SharedHotelSetupHttpClient = {
      get: async <T>() => response as T,
      post: async <T>() => response as T,
      put: async <T>(endpoint: string, data?: unknown, options?: RequestInit) => {
        calls.push({ endpoint, data, options });
        return response as T;
      },
    };
    const api = createSharedHotelSetupApi(client);

    await expect(
      api.replacePropertyPresentationMedia(
        propertyId,
        {
          expectedProfileRevision: 7,
          assignments: [{ mediaObjectId, role: "cover", altText: null, sortOrder: 0 }],
        },
        "cover-assignment-1",
      ),
    ).resolves.toEqual(response);
    expect(calls).toEqual([
      {
        endpoint: `/api/hotel-setup/properties/${propertyId}/media/presentation`,
        data: {
          expectedProfileRevision: 7,
          assignments: [{ mediaObjectId, role: "cover", altText: null, sortOrder: 0 }],
        },
        options: { headers: { "Idempotency-Key": "cover-assignment-1" } },
      },
    ]);
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
