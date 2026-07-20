import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiClient: mocks };
});

vi.mock("@vayada/marketplace-shared/api/discovery", () => ({
  getAllMarketplaceOffers: vi.fn(),
}));

import { clearAuthData, setAuthKitSession } from "@/services/auth/sessionStore";
import { hotelService } from "./hotels";

const propertyId = "property-two";

const sharedProfile = {
  propertyId,
  publicId: "hotel-alpenrose",
  displayName: "Hotel Alpenrose",
  propertyType: "hotel",
  location: {
    countryCode: "DE",
    region: "Bavaria",
    city: "Munich",
    streetAddress: null,
    postalCode: null,
    rawMarketplaceLocation: "Munich, Germany",
    timezone: "Europe/Berlin",
    latitude: null,
    longitude: null,
    addressPublic: false,
    mapDisplayMode: "approximate",
  },
  website: "https://alpenrose.example",
  contactEmail: "hello@alpenrose.example",
  phone: "+49 89 123456",
  shortDescription: "Independent city hotel",
  longDescription: null,
  media: [
    {
      mediaType: "hero_image",
      url: "https://images.example/alpenrose.jpg",
      altText: "Hotel Alpenrose",
      sortOrder: 0,
    },
  ],
  sharedProfile: {
    complete: true,
    missingFields: [],
    source: "canonical",
    lastUpdatedAt: "2026-07-11T00:00:00.000Z",
  },
  updatedAt: "2026-07-11T00:00:00.000Z",
};

const marketplaceProfile = {
  propertyId,
  profileStatus: "pending",
  profileComplete: true,
  hostSummary: "A friendly independent hotel.",
  collaborationGuidelines: null,
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
};

const targetOffer = {
  offerId: "offer-resource-id",
  mediaResourceId: "offer-resource-id",
  propertyId,
  offerStatus: "pending",
  title: "Two-night city stay",
  offerSummary: "Stay close to the old town.",
  media: [
    {
      mediaObjectId: "offer-media-one",
      url: "https://images.example/offer-one.jpg",
    },
  ],
  deliverables: [
    {
      deliverableId: "deliverable-one",
      platform: "instagram",
      deliverableType: "content",
      quantity: 1,
      timingGuidance: null,
    },
  ],
  compensationOptions: [
    {
      compensationOptionId: "compensation-one",
      compensationType: "free_stay",
      availabilityMonths: ["July"],
      platforms: ["instagram"],
      freeStayMinNights: 1,
      freeStayMaxNights: 2,
      paidMaxAmount: null,
      discountPercentage: null,
      commissionPercentage: null,
      minFollowers: 1000,
      currency: null,
      termsSummary: null,
    },
  ],
  creatorRequirements: {
    platforms: ["instagram"],
    targetCountries: ["DE"],
    targetAgeMin: 18,
    targetAgeMax: 34,
    targetAgeGroups: ["18-24", "25-34"],
    creatorTypes: ["travel"],
  },
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
};

beforeEach(() => {
  const localStorage = createStorage({
    selectedSharedPropertyId: propertyId,
    selectedSharedPropertyOrganizationId: "org-hotel-group",
  });
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("localStorage", localStorage);
  setAuthKitSession({
    accessToken: "workos-access-token",
    organizationId: "org-hotel-group",
    organizationKind: "hotel_group",
    user: { id: "user-owner", email: "owner@example.com", status: "active" },
  });
});

afterEach(() => {
  clearAuthData();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hotel target self-service client", () => {
  it("loads profile status for the explicitly selected hotel", async () => {
    const profileStatus = {
      profile_complete: true,
      missing_fields: [],
      has_defaults: { location: false },
      missing_offers: false,
      completion_steps: [],
    };
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(requestHeader(init, "Authorization")).toBe("Bearer workos-access-token");
      return jsonResponse(profileStatus);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(hotelService.getProfileStatus()).resolves.toEqual(profileStatus);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.localhost/api/marketplace/properties/${propertyId}/profile-status`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("combines canonical hotel facts with the selected Marketplace profile and offers", async () => {
    localStorage.setItem("selectedSharedPropertyId", "stale-property");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        switch (String(url)) {
          case `https://api.localhost/api/hotel-setup/properties/${propertyId}/profile`:
            return jsonResponse(sharedProfile);
          case `https://api.localhost/api/marketplace/properties/${propertyId}/profile`:
            return jsonResponse(marketplaceProfile);
          case `https://api.localhost/api/marketplace/properties/${propertyId}/offers`:
            return jsonResponse({
              offers: [
                targetOffer,
                {
                  ...targetOffer,
                  offerId: "offer-two",
                  mediaResourceId: "offer-two",
                  title: "Second offer",
                  media: [
                    {
                      mediaObjectId: "offer-media-two",
                      url: "https://images.example/offer-two.jpg",
                    },
                  ],
                },
              ],
            });
          default:
            throw new Error(`Unexpected fetch: ${url}`);
        }
      }),
    );

    await expect(hotelService.getMyProfile(propertyId)).resolves.toMatchObject({
      id: propertyId,
      name: "Hotel Alpenrose",
      location: "Munich, Germany",
      picture: "https://images.example/alpenrose.jpg",
      about: "A friendly independent hotel.",
      email: "hello@alpenrose.example",
      listings: [
        {
          id: "offer-resource-id",
          media_resource_id: "offer-resource-id",
          hotel_profile_id: propertyId,
          name: "Two-night city stay",
          images: ["https://images.example/offer-one.jpg"],
          image_media_object_ids: ["offer-media-one"],
          collaboration_offerings: [
            expect.objectContaining({
              collaboration_type: "Free Stay",
              platforms: ["Instagram"],
            }),
          ],
        },
        {
          id: "offer-two",
          name: "Second offer",
          images: ["https://images.example/offer-two.jpg"],
          image_media_object_ids: ["offer-media-two"],
        },
      ],
    });
  });

  it("keeps two offer galleries distinct after editing and reloading", async () => {
    const secondOffer = {
      ...targetOffer,
      offerId: "offer-two",
      mediaResourceId: "offer-two",
      title: "Second offer",
      media: [
        {
          mediaObjectId: "offer-media-two",
          url: "https://images.example/offer-two.jpg",
        },
      ],
    };
    let offers = [targetOffer, secondOffer];
    const propertyWrites: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
          if (method === "PUT") propertyWrites.push(JSON.parse(String(init?.body)));
          return jsonResponse(sharedProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/profile`)) {
          return jsonResponse(marketplaceProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/offers/offer-resource-id`)) {
          offers = [{ ...offers[0]!, title: "Edited first offer" }, offers[1]!];
          return jsonResponse(offers[0]);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/offers`)) {
          return jsonResponse({ offers });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      }),
    );

    await hotelService.updateListing("offer-resource-id", {
      name: "Edited first offer",
      images: ["https://images.example/offer-one.jpg"],
    });
    const reloaded = await hotelService.getMyProfile();

    expect(reloaded.listings.map(({ name, images }) => ({ name, images }))).toEqual([
      {
        name: "Edited first offer",
        images: ["https://images.example/offer-one.jpg"],
      },
      { name: "Second offer", images: ["https://images.example/offer-two.jpg"] },
    ]);
    expect(propertyWrites).toEqual([]);
  });

  it("writes canonical hotel fields and Marketplace copy to their owning routes", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      requests.push({
        url: href,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });

      if (href.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
        return jsonResponse(
          method === "PUT"
            ? {
                ...sharedProfile,
                displayName: "Alpenrose City Hotel",
                phone: "+49 89 999999",
              }
            : sharedProfile,
        );
      }
      if (href.endsWith(`/marketplace/properties/${propertyId}/profile`)) {
        return jsonResponse({
          ...marketplaceProfile,
          hostSummary: "A personal stay in central Munich.",
        });
      }
      if (href.endsWith(`/marketplace/properties/${propertyId}/offers`)) {
        return jsonResponse({ offers: [targetOffer] });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await hotelService.updateMyProfile({
      name: "Alpenrose City Hotel",
      phone: "+49 89 999999",
      about: "A personal stay in central Munich.",
    });

    expect(requests).toContainEqual(
      expect.objectContaining({
        url: `https://api.localhost/api/hotel-setup/properties/${propertyId}/profile`,
        method: "PUT",
        body: expect.objectContaining({
          displayName: "Alpenrose City Hotel",
          phone: "+49 89 999999",
        }),
      }),
    );
    expect(requests).toContainEqual({
      url: `https://api.localhost/api/marketplace/properties/${propertyId}/profile`,
      method: "PUT",
      body: { hostSummary: "A personal stay in central Munich." },
    });

    requests.length = 0;
    localStorage.setItem("selectedSharedPropertyId", "stale-property");
    await hotelService.updateMyProfile(
      { about: "A creator-focused stay in central Munich." },
      propertyId,
    );

    expect(requests).not.toContainEqual(
      expect.objectContaining({
        url: `https://api.localhost/api/hotel-setup/properties/${propertyId}/profile`,
        method: "PUT",
      }),
    );
    expect(requests).toContainEqual({
      url: `https://api.localhost/api/marketplace/properties/${propertyId}/profile`,
      method: "PUT",
      body: { hostSummary: "A creator-focused stay in central Munich." },
    });
  });

  it("scopes offer create, update, and delete to the selected hotel", async () => {
    localStorage.setItem("selectedSharedPropertyId", "stale-property");
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        requests.push({
          url: String(url),
          method,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        const href = String(url);
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
          return jsonResponse(sharedProfile);
        }
        if (method === "DELETE") {
          expect(requestHeader(init, "Content-Type")).toBeNull();
        }
        return method === "DELETE" ? emptyResponse() : jsonResponse(targetOffer);
      }),
    );

    const createRequest = {
      name: "Two-night city stay",
      location: "Munich",
      description: "Stay close to the old town.",
      accommodation_type: "Boutique Hotel",
      images: ["https://images.example/room.jpg"],
      deliverables: [
        {
          platform: "TikTok",
          deliverable_type: "content",
          quantity: 1,
          timing_guidance: null,
        },
      ],
      collaboration_offerings: [
        {
          collaboration_type: "Free Stay" as const,
          availability_months: ["July"],
          platforms: ["Instagram"],
          free_stay_min_nights: 1,
          free_stay_max_nights: 2,
          min_followers: 1000,
        },
      ],
      creator_requirements: {
        platforms: ["Instagram"],
        target_countries: ["DE"],
        target_age_min: 18,
        target_age_max: 34,
        target_age_groups: ["18-24", "25-34"],
        creator_types: ["Travel"],
      },
    };

    const created = await hotelService.createListing(createRequest, propertyId);
    const updated = await hotelService.updateListing(
      "offer-resource-id",
      {
        name: "Updated stay",
        images: ["https://images.example/offer-one.jpg"],
      },
      propertyId,
    );
    await hotelService.deleteListing("offer-resource-id", propertyId);

    expect(requests).toContainEqual({
      url: `https://api.localhost/api/marketplace/properties/${propertyId}/offers`,
      method: "POST",
      body: expect.objectContaining({
        title: "Two-night city stay",
        deliverables: [
          {
            platform: "tiktok",
            deliverableType: "content",
            quantity: 1,
            timingGuidance: null,
          },
        ],
        compensationOptions: [
          expect.objectContaining({
            compensationType: "free_stay",
            platforms: ["instagram"],
            minFollowers: 1000,
          }),
        ],
        creatorRequirements: expect.objectContaining({
          platforms: ["instagram"],
          creatorTypes: ["travel"],
        }),
      }),
    });
    expect(requests).toContainEqual({
      url: `https://api.localhost/api/marketplace/properties/${propertyId}/offers/offer-resource-id`,
      method: "PUT",
      body: { title: "Updated stay" },
    });
    expect(requests).toContainEqual({
      url: `https://api.localhost/api/marketplace/properties/${propertyId}/offers/offer-resource-id`,
      method: "DELETE",
      body: null,
    });
    expect(created).toMatchObject({
      location: "Munich, Germany",
      accommodation_type: "hotel",
    });
    expect(updated).toMatchObject({
      location: "Munich, Germany",
      accommodation_type: "hotel",
    });
    expect(
      requests.filter(
        (request) =>
          request.url ===
            `https://api.localhost/api/hotel-setup/properties/${propertyId}/profile` &&
          request.method === "PUT",
      ),
    ).toEqual([]);
  });

  it("authorizes offer image uploads with the opaque media resource ID", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/media/upload-sessions")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          purpose: "marketplace.offer.media",
          resource: {
            product: "marketplace",
            resourceType: "marketplace_offer",
            resourceId: "offer-resource-id",
          },
        });
        return jsonResponse({
          uploadSession: { sessionId: "upload-session" },
          uploadTargets: [
            {
              uploadTargetId: "upload-target",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/upload-target",
              headers: {},
            },
          ],
        });
      }
      if (String(url).endsWith("/api/media/upload-sessions/upload-session/finalize")) {
        return jsonResponse({
          mediaObjects: [
            {
              mediaId: "media-id",
              storageKey: "private/marketplace/offers/media-id/original-safe.webp",
              contentType: "image/jpeg",
              sizeBytes: 3,
              originalFilename: "image.jpg",
              variants: [
                {
                  publicCdnUrl: null,
                  storageKey: "private/marketplace/offers/media-id/original-safe.webp",
                },
              ],
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      hotelService.uploadListingImages(
        [new File(["img"], "image.jpg", { type: "image/jpeg" })],
        "offer-resource-id",
      ),
    ).resolves.toEqual({
      images: [
        {
          url: "private/marketplace/offers/media-id/original-safe.webp",
          mediaObjectId: "media-id",
        },
      ],
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  const serialized = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    json: async () => body,
    text: async () => serialized,
  } as Response;
}

function emptyResponse(): Response {
  return {
    ok: true,
    status: 204,
    headers: { get: () => null },
  } as unknown as Response;
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function createStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}
