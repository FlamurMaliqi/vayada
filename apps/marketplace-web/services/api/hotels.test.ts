import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PropertyProfileResponse } from "@vayada/domain-hotels";

vi.mock("@vayada/marketplace-shared/api/discovery", () => ({
  getAllMarketplaceOffers: vi.fn(),
}));

import { clearAuthData, setAuthKitSession } from "@/services/auth/sessionStore";
import {
  advanceHotelProfileRevisionsAfterCoverUpload,
  CanonicalHotelPhotoReuseError,
  HotelAddressSetupRequiredError,
  hotelService,
} from "./hotels";

const propertyId = "property-two";

const sharedProfile = {
  propertyId,
  profileRevision: 3,
  profile: {
    displayName: "Hotel Alpenrose",
    propertyType: "hotel",
    location: {
      countryCode: "DE",
      city: "Munich",
      streetAddress: "Alpenweg 1",
      postalCode: "80331",
      timezone: "Europe/Berlin",
      latitude: null,
      longitude: null,
      localityPublic: false,
      geoPublic: false,
      mapDisplayMode: "approximate",
    },
    contacts: [
      {
        channelType: "website",
        value: "https://alpenrose.example",
        purpose: "general",
        isPublic: true,
      },
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
};

const publicProfile = {
  propertyId,
  profileRevision: 7,
  publicProfile: {
    locale: "en",
    shortDescription: "A welcoming independent hotel.",
    longDescription: "A longer public description of Hotel Alpenrose.",
    media: [
      {
        mediaObjectId: "00000000-0000-4000-8000-000000000001",
        mediaType: "hero_image",
        url: "https://images.example/hotel-hero.jpg",
        altText: "Hotel Alpenrose",
        sortOrder: 0,
      },
    ],
  },
};
const profileRevisions = {
  canonicalProfileRevision: sharedProfile.profileRevision,
  publicProfileRevision: publicProfile.profileRevision,
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
      termsSummary: "Breakfast and local taxes are included.",
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
  it("uses the successful canonical hero revision for both profile views", () => {
    expect(
      advanceHotelProfileRevisionsAfterCoverUpload({
        canonicalProfileRevision: 7,
        publicProfileRevision: 6,
      }),
    ).toEqual({
      canonicalProfileRevision: 8,
      publicProfileRevision: 8,
    });
  });

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
          case `https://api.localhost/api/hotel-setup/properties/${propertyId}/public-profile`:
            return jsonResponse(publicProfile);
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
      picture: "https://images.example/hotel-hero.jpg",
      about: "A welcoming independent hotel.",
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
              terms_summary: "Breakfast and local taxes are included.",
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

  it("uses the canonical public description when the Marketplace copy is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        switch (String(url)) {
          case `https://api.localhost/api/hotel-setup/properties/${propertyId}/profile`:
            return jsonResponse(sharedProfile);
          case `https://api.localhost/api/hotel-setup/properties/${propertyId}/public-profile`:
            return jsonResponse(publicProfile);
          case `https://api.localhost/api/marketplace/properties/${propertyId}/profile`:
            return jsonResponse({ ...marketplaceProfile, hostSummary: null });
          case `https://api.localhost/api/marketplace/properties/${propertyId}/offers`:
            return jsonResponse({ offers: [] });
          default:
            throw new Error(`Unexpected fetch: ${url}`);
        }
      }),
    );

    await expect(hotelService.getMyProfile()).resolves.toMatchObject({
      about: "A welcoming independent hotel.",
      picture: "https://images.example/hotel-hero.jpg",
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
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`)) {
          return jsonResponse(publicProfile);
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

  it("writes shared, public, and Marketplace fields to their owning routes", async () => {
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
                profileRevision: 4,
                profile: {
                  ...sharedProfile.profile,
                  displayName: "Alpenrose City Hotel",
                  contacts: sharedProfile.profile.contacts.map((contact) =>
                    contact.channelType === "phone"
                      ? { ...contact, value: "+49 89 999999" }
                      : contact,
                  ),
                },
              }
            : sharedProfile,
        );
      }
      if (href.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`)) {
        return jsonResponse(
          method === "PUT"
            ? {
                ...publicProfile,
                profileRevision: 8,
                publicProfile: {
                  ...publicProfile.publicProfile,
                  shortDescription: "A personal stay in central Munich.",
                },
              }
            : publicProfile,
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

    await hotelService.updateMyProfile(
      {
        name: "Alpenrose City Hotel",
        phone: "+49 89 999999",
        about: "A personal stay in central Munich.",
      },
      undefined,
      profileRevisions,
    );

    expect(requests).toContainEqual({
      url: `https://api.localhost/api/hotel-setup/properties/${propertyId}/profile`,
      method: "PUT",
      body: {
        expectedProfileRevision: 3,
        patch: {
          displayName: "Alpenrose City Hotel",
          contacts: sharedProfile.profile.contacts.map((contact) =>
            contact.channelType === "phone" ? { ...contact, value: "+49 89 999999" } : contact,
          ),
        },
      },
    });
    expect(requests).toContainEqual({
      url: `https://api.localhost/api/hotel-setup/properties/${propertyId}/public-profile`,
      method: "PUT",
      body: {
        expectedProfileRevision: 4,
        patch: { shortDescription: "A personal stay in central Munich." },
      },
    });
    expect(requests).toContainEqual({
      url: `https://api.localhost/api/marketplace/properties/${propertyId}/profile`,
      method: "PUT",
      body: { hostSummary: "A personal stay in central Munich." },
    });
    const sharedWriteIndex = requests.findIndex(
      ({ url, method }) =>
        url.endsWith(`/hotel-setup/properties/${propertyId}/profile`) && method === "PUT",
    );
    const latestPublicReadIndex = requests.findIndex(
      ({ url, method }) =>
        url.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`) && method === "GET",
    );
    const publicWriteIndex = requests.findIndex(
      ({ url, method }) =>
        url.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`) && method === "PUT",
    );
    expect(sharedWriteIndex).toBeGreaterThanOrEqual(0);
    expect(latestPublicReadIndex).toBeGreaterThan(sharedWriteIndex);
    expect(publicWriteIndex).toBeGreaterThan(latestPublicReadIndex);

    requests.length = 0;
    localStorage.setItem("selectedSharedPropertyId", "stale-property");
    await hotelService.updateMyProfile(
      { about: "A creator-focused stay in central Munich." },
      propertyId,
      profileRevisions,
    );

    expect(requests).not.toContainEqual(
      expect.objectContaining({
        url: `https://api.localhost/api/hotel-setup/properties/${propertyId}/profile`,
        method: "PUT",
      }),
    );
    expect(requests).toContainEqual({
      url: `https://api.localhost/api/hotel-setup/properties/${propertyId}/public-profile`,
      method: "PUT",
      body: {
        expectedProfileRevision: 7,
        patch: { shortDescription: "A creator-focused stay in central Munich." },
      },
    });
    expect(requests).toContainEqual({
      url: `https://api.localhost/api/marketplace/properties/${propertyId}/profile`,
      method: "PUT",
      body: { hostSummary: "A creator-focused stay in central Munich." },
    });
  });

  it("persists locality consent through the canonical CAS profile", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    let currentProfile = sharedProfile;
    const offers = [
      targetOffer,
      {
        ...targetOffer,
        offerId: "offer-resource-two",
        mediaResourceId: "offer-resource-two",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url: href, method, body });

        if (href.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
          if (method === "PUT") {
            currentProfile = {
              ...sharedProfile,
              profileRevision: 4,
              profile: {
                ...sharedProfile.profile,
                location: { ...sharedProfile.profile.location, localityPublic: true },
              },
            };
          }
          return jsonResponse(currentProfile);
        }
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`)) {
          return jsonResponse(publicProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/profile`)) {
          return jsonResponse(marketplaceProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/offers`)) {
          return jsonResponse({ offers });
        }
        throw new Error(`Unexpected fetch: ${method} ${href}`);
      }),
    );

    await expect(
      hotelService.updateMyProfile({ localityPublic: true }, propertyId, profileRevisions),
    ).resolves.toMatchObject({ localityPublic: true });

    expect(requests).toContainEqual({
      url: `https://api.localhost/api/hotel-setup/properties/${propertyId}/profile`,
      method: "PUT",
      body: {
        expectedProfileRevision: 3,
        patch: { location: { localityPublic: true } },
      },
    });
    expect(requests.some(({ url, method }) => url.includes("/offers/") && method === "PUT")).toBe(
      false,
    );
  });

  it("resumes the shared hotel description after locality saved but the public write failed", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    let currentProfile = sharedProfile;
    let currentPublicProfile = publicProfile;
    let publicWriteAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url: href, method, body });

        if (href.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
          if (method === "PUT") {
            currentProfile = {
              ...sharedProfile,
              profileRevision: 4,
              profile: {
                ...sharedProfile.profile,
                location: { ...sharedProfile.profile.location, localityPublic: true },
              },
            };
            currentPublicProfile = { ...publicProfile, profileRevision: 4 };
          }
          return jsonResponse(currentProfile);
        }
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`)) {
          if (method === "PUT") {
            publicWriteAttempts += 1;
            if (publicWriteAttempts === 1) {
              return jsonResponse({ detail: "Temporary public profile failure" }, 503);
            }
            currentPublicProfile = {
              ...currentPublicProfile,
              profileRevision: 5,
              publicProfile: {
                ...currentPublicProfile.publicProfile,
                shortDescription: "A public description saved after retry.",
              },
            };
          }
          return jsonResponse(currentPublicProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/profile`)) {
          return jsonResponse(marketplaceProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/offers`)) {
          return jsonResponse({ offers: [targetOffer] });
        }
        throw new Error(`Unexpected fetch: ${method} ${href}`);
      }),
    );

    const save = () =>
      hotelService.updatePublicSetupProfile(
        {
          about: "A public description saved after retry.",
          localityPublic: true,
        },
        propertyId,
        profileRevisions,
      );

    await expect(save()).rejects.toBeTruthy();
    await expect(save()).resolves.toMatchObject({
      localityPublic: true,
      publicAbout: "A public description saved after retry.",
    });

    expect(
      requests.filter(
        ({ url, method }) =>
          url.endsWith(`/hotel-setup/properties/${propertyId}/profile`) && method === "PUT",
      ),
    ).toHaveLength(1);
    expect(
      requests
        .filter(
          ({ url, method }) =>
            url.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`) &&
            method === "PUT",
        )
        .map(({ body }) => body),
    ).toEqual([
      {
        expectedProfileRevision: 4,
        patch: { shortDescription: "A public description saved after retry." },
      },
      {
        expectedProfileRevision: 4,
        patch: { shortDescription: "A public description saved after retry." },
      },
    ]);
    expect(
      requests
        .filter(
          ({ url, method }) =>
            url.endsWith(`/marketplace/properties/${propertyId}/profile`) && method === "PUT",
        )
        .map(({ body }) => body),
    ).toEqual([{ hostSummary: "A public description saved after retry." }]);
  });

  it("retries only the Marketplace copy when the canonical description already saved", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    let currentPublicProfile = publicProfile;
    let currentMarketplaceProfile = marketplaceProfile;
    let marketplaceWriteAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url: href, method, body });

        if (href.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
          return jsonResponse(sharedProfile);
        }
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`)) {
          if (method === "PUT") {
            currentPublicProfile = {
              ...publicProfile,
              profileRevision: 8,
              publicProfile: {
                ...publicProfile.publicProfile,
                shortDescription: "One description for guests and creators.",
              },
            };
          }
          return jsonResponse(currentPublicProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/profile`)) {
          if (method === "PUT") {
            marketplaceWriteAttempts += 1;
            if (marketplaceWriteAttempts === 1) {
              return jsonResponse({ detail: "Temporary Marketplace profile failure" }, 503);
            }
            currentMarketplaceProfile = {
              ...marketplaceProfile,
              hostSummary: "One description for guests and creators.",
            };
          }
          return jsonResponse(currentMarketplaceProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/offers`)) {
          return jsonResponse({ offers: [targetOffer] });
        }
        throw new Error(`Unexpected fetch: ${method} ${href}`);
      }),
    );

    const save = () =>
      hotelService.updatePublicSetupProfile(
        {
          about: "One description for guests and creators.",
          localityPublic: false,
        },
        propertyId,
        profileRevisions,
      );

    await expect(save()).rejects.toBeTruthy();
    await expect(save()).resolves.toMatchObject({
      publicAbout: "One description for guests and creators.",
      marketplaceAbout: "One description for guests and creators.",
    });

    expect(
      requests.filter(
        ({ url, method }) =>
          url.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`) && method === "PUT",
      ),
    ).toHaveLength(1);
    expect(
      requests
        .filter(
          ({ url, method }) =>
            url.endsWith(`/marketplace/properties/${propertyId}/profile`) && method === "PUT",
        )
        .map(({ body }) => body),
    ).toEqual([
      { hostSummary: "One description for guests and creators." },
      { hostSummary: "One description for guests and creators." },
    ]);
  });

  it("resumes a multi-field profile save after canonical and public writes already committed", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    let currentProfile = sharedProfile;
    let currentPublicProfile = publicProfile;
    let currentMarketplaceProfile = marketplaceProfile;
    let marketplaceWriteAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url: href, method, body });

        if (href.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
          if (method === "PUT") {
            currentProfile = {
              ...sharedProfile,
              profileRevision: 4,
              profile: {
                ...sharedProfile.profile,
                displayName: "Alpenrose Retry Hotel",
                contacts: sharedProfile.profile.contacts.map((contact) =>
                  contact.channelType === "phone"
                    ? { ...contact, value: "+49 89 111111" }
                    : contact,
                ),
              },
            };
            currentPublicProfile = { ...publicProfile, profileRevision: 4 };
          }
          return jsonResponse(currentProfile);
        }
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`)) {
          if (method === "PUT") {
            currentPublicProfile = {
              ...currentPublicProfile,
              profileRevision: 5,
              publicProfile: {
                ...currentPublicProfile.publicProfile,
                shortDescription: "Retry-safe description.",
              },
            };
          }
          return jsonResponse(currentPublicProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/profile`)) {
          if (method === "PUT") {
            marketplaceWriteAttempts += 1;
            if (marketplaceWriteAttempts === 1) {
              return jsonResponse({ detail: "Temporary Marketplace profile failure" }, 503);
            }
            currentMarketplaceProfile = {
              ...marketplaceProfile,
              hostSummary: "Retry-safe description.",
            };
          }
          return jsonResponse(currentMarketplaceProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/offers`)) {
          return jsonResponse({ offers: [targetOffer] });
        }
        throw new Error(`Unexpected fetch: ${method} ${href}`);
      }),
    );

    const save = () =>
      hotelService.updateMyProfile(
        {
          name: "Alpenrose Retry Hotel",
          phone: "+49 89 111111",
          about: "Retry-safe description.",
        },
        propertyId,
        profileRevisions,
      );

    await expect(save()).rejects.toBeTruthy();
    await expect(save()).resolves.toMatchObject({
      name: "Alpenrose Retry Hotel",
      phone: "+49 89 111111",
      publicAbout: "Retry-safe description.",
      marketplaceAbout: "Retry-safe description.",
    });

    expect(
      requests.filter(
        ({ url, method }) =>
          url.endsWith(`/hotel-setup/properties/${propertyId}/profile`) && method === "PUT",
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        ({ url, method }) =>
          url.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`) && method === "PUT",
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        ({ url, method }) =>
          url.endsWith(`/marketplace/properties/${propertyId}/profile`) && method === "PUT",
      ),
    ).toHaveLength(2);
  });

  it("does not treat a same-valued non-general contact as an applied canonical write", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const guestPhone = {
      channelType: "phone" as const,
      value: "+49 89 555555",
      purpose: "guest" as const,
      isPublic: false,
    };
    const baseProfile = sharedProfile as PropertyProfileResponse;
    let currentProfile: PropertyProfileResponse = {
      ...baseProfile,
      profile: { ...baseProfile.profile, contacts: [guestPhone] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url: href, method, body });
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
          if (method === "PUT") {
            currentProfile = {
              ...currentProfile,
              profileRevision: 4,
              profile: {
                ...currentProfile.profile,
                contacts: [
                  guestPhone,
                  {
                    channelType: "phone",
                    value: "+49 89 555555",
                    purpose: "general",
                    isPublic: false,
                  },
                ],
              },
            };
          }
          return jsonResponse(currentProfile);
        }
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`)) {
          return jsonResponse(publicProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/profile`)) {
          return jsonResponse(marketplaceProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/offers`)) {
          return jsonResponse({ offers: [targetOffer] });
        }
        throw new Error(`Unexpected fetch: ${method} ${href}`);
      }),
    );

    await hotelService.updateMyProfile({ phone: "+49 89 555555" }, propertyId, profileRevisions);

    expect(requests).toContainEqual({
      url: `https://api.localhost/api/hotel-setup/properties/${propertyId}/profile`,
      method: "PUT",
      body: {
        expectedProfileRevision: 3,
        patch: {
          contacts: [
            guestPhone,
            {
              channelType: "phone",
              value: "+49 89 555555",
              purpose: "general",
              isPublic: false,
            },
          ],
        },
      },
    });
  });

  it("sends the editor-loaded revision so a stale save reaches the backend conflict check", async () => {
    const requests: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        requests.push({
          method,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
          if (method === "PUT") {
            return jsonResponse(
              {
                detail: {
                  code: "profile_revision_conflict",
                  currentProfileRevision: 12,
                },
              },
              409,
            );
          }
          return jsonResponse({ ...sharedProfile, profileRevision: 12 });
        }
        throw new Error(`Unexpected fetch: ${method} ${href}`);
      }),
    );

    await expect(
      hotelService.updateMyProfile({ localityPublic: true }, propertyId, profileRevisions),
    ).rejects.toBeTruthy();
    expect(requests.find(({ method }) => method === "PUT")?.body).toEqual({
      expectedProfileRevision: 3,
      patch: { location: { localityPublic: true } },
    });
  });

  it("removes only hero media when the hotel picture is deleted", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const galleryMedia = {
      mediaObjectId: "00000000-0000-4000-8000-000000000002",
      mediaType: "gallery_image" as const,
      url: "https://images.example/hotel-gallery.jpg",
      altText: "Hotel courtyard",
      sortOrder: 1,
    };
    let currentPublicProfile = {
      ...publicProfile,
      publicProfile: {
        ...publicProfile.publicProfile,
        media: [...publicProfile.publicProfile.media, galleryMedia],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        requests.push({
          url: href,
          method,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
          return jsonResponse(sharedProfile);
        }
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`)) {
          if (method === "PUT") {
            currentPublicProfile = {
              ...currentPublicProfile,
              profileRevision: 8,
              publicProfile: {
                ...currentPublicProfile.publicProfile,
                media: [galleryMedia],
              },
            };
          }
          return jsonResponse(currentPublicProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/profile`)) {
          return jsonResponse(marketplaceProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/offers`)) {
          return jsonResponse({ offers: [targetOffer] });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      }),
    );

    await expect(
      hotelService.updateMyProfile({ picture: null }, undefined, profileRevisions),
    ).resolves.toMatchObject({ picture: galleryMedia.url });
    expect(requests).toContainEqual({
      url: `https://api.localhost/api/hotel-setup/properties/${propertyId}/public-profile`,
      method: "PUT",
      body: {
        expectedProfileRevision: 7,
        patch: {
          media: [
            {
              mediaObjectId: galleryMedia.mediaObjectId,
              altText: galleryMedia.altText,
              sortOrder: 0,
            },
          ],
        },
      },
    });
  });

  it("resyncs the public profile after a canonical cover upload", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const newMediaObjectId = "00000000-0000-4000-8000-000000000099";
    const galleryMedia = {
      mediaObjectId: "00000000-0000-4000-8000-000000000002",
      mediaType: "gallery_image" as const,
      url: "https://images.example/hotel-gallery.jpg",
      altText: "Hotel courtyard",
      sortOrder: 1,
    };
    let currentPublicProfile = {
      ...publicProfile,
      publicProfile: {
        ...publicProfile.publicProfile,
        media: [...publicProfile.publicProfile.media, galleryMedia],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url: href, method, body });
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
          return jsonResponse(sharedProfile);
        }
        if (href.endsWith(`/hotel-setup/properties/${propertyId}/public-profile`)) {
          if (method === "PUT") {
            currentPublicProfile = {
              ...currentPublicProfile,
              profileRevision: 8,
              publicProfile: {
                ...currentPublicProfile.publicProfile,
                media: [
                  {
                    mediaObjectId: newMediaObjectId,
                    mediaType: "hero_image",
                    url: "https://images.example/new-hotel-hero.jpg",
                    altText: "",
                    sortOrder: 0,
                  },
                  galleryMedia,
                ],
              },
            };
          }
          return jsonResponse(currentPublicProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/profile`)) {
          return jsonResponse(marketplaceProfile);
        }
        if (href.endsWith(`/marketplace/properties/${propertyId}/offers`)) {
          return jsonResponse({ offers: [targetOffer] });
        }
        throw new Error(`Unexpected fetch: ${method} ${href}`);
      }),
    );

    await expect(
      hotelService.updateMyProfile(
        {
          picture: "https://images.example/new-hotel-hero.jpg",
          pictureMediaObjectId: newMediaObjectId,
          picture_media_object_id: newMediaObjectId,
        },
        propertyId,
        advanceHotelProfileRevisionsAfterCoverUpload(profileRevisions),
      ),
    ).resolves.toMatchObject({
      picture: "https://images.example/new-hotel-hero.jpg",
    });

    expect(requests).toContainEqual({
      url: `https://api.localhost/api/hotel-setup/properties/${propertyId}/public-profile`,
      method: "PUT",
      body: {
        expectedProfileRevision: 4,
        patch: {
          media: [
            {
              mediaObjectId: newMediaObjectId,
              altText: null,
              sortOrder: 0,
            },
            {
              mediaObjectId: galleryMedia.mediaObjectId,
              altText: galleryMedia.altText,
              sortOrder: 1,
            },
          ],
        },
      },
    });
  });

  it("rejects freeform location edits and directs the owner back to hotel setup", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
        return jsonResponse(sharedProfile);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      hotelService.updateMyProfile({ location: "Berlin, Germany" }, undefined, profileRevisions),
    ).rejects.toEqual(new HotelAddressSetupRequiredError());
    expect(fetchMock).toHaveBeenCalledOnce();
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
        if (method === "POST") {
          expect(requestHeader(init, "Idempotency-Key")).toBe(
            "marketplace.hotel-onboarding.offer:draft-offer-one:v1",
          );
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

    const created = await hotelService.createListing(createRequest, propertyId, {
      idempotencyKey: "marketplace.hotel-onboarding.offer:draft-offer-one:v1",
    });
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

  it("returns completed upload-session media without uploading or finalizing again", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).endsWith("/api/media/upload-sessions")) {
        throw new Error(`Unexpected replay request: ${url}`);
      }
      return jsonResponse({
        uploadSession: { sessionId: "completed-session", status: "completed" },
        uploadTargets: [],
        mediaObjects: [
          {
            mediaId: "replayed-media-id",
            storageKey: "private/marketplace/offers/replayed-media-id/original-safe.webp",
            contentType: "image/jpeg",
            sizeBytes: 3,
            originalFilename: "image.jpg",
            variants: [
              {
                publicCdnUrl: null,
                storageKey: "private/marketplace/offers/replayed-media-id/original-safe.webp",
              },
            ],
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      hotelService.uploadListingImages(
        [new File(["img"], "image.jpg", { type: "image/jpeg" })],
        "offer-resource-id",
        { idempotencyKey: "marketplace.offer-media:retry" },
      ),
    ).resolves.toEqual({
      images: [
        {
          url: "private/marketplace/offers/replayed-media-id/original-safe.webp",
          mediaObjectId: "replayed-media-id",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("copies a canonical hotel photo into offer-owned media", async () => {
    const sourceUrl = "https://images.example/alpenrose.webp";
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === sourceUrl) {
        expect(init).toEqual({ credentials: "omit" });
        return new Response(new Blob(["hotel-image"], { type: "image/webp" }), { status: 200 });
      }
      if (String(url).endsWith("/api/media/upload-sessions")) {
        const body = JSON.parse(String(init?.body));
        expect(body.idempotencyKey).toMatch(
          /^marketplace\.offer-media:test-command:files:sha256:[0-9a-f]{64}$/,
        );
        expect(body.files).toEqual([
          expect.objectContaining({
            filename: "shared-hotel-photo-1.webp",
            contentType: "image/webp",
          }),
        ]);
        return jsonResponse({
          uploadSession: { sessionId: "copy-session" },
          uploadTargets: [
            {
              uploadTargetId: "copy-target",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/copy-target",
              headers: {},
            },
          ],
        });
      }
      if (String(url).endsWith("/api/media/upload-sessions/copy-session/finalize")) {
        return jsonResponse({
          mediaObjects: [
            {
              mediaId: "copied-media-id",
              storageKey: "private/marketplace/offers/copied-media-id/original-safe.webp",
              contentType: "image/webp",
              sizeBytes: 11,
              originalFilename: "shared-hotel-photo-1.webp",
              variants: [
                {
                  publicCdnUrl: null,
                  storageKey: "private/marketplace/offers/copied-media-id/original-safe.webp",
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
      hotelService.uploadListingImagesFromSources([sourceUrl], [], "offer-resource-id", {
        idempotencyKey: "marketplace.offer-media:test-command",
      }),
    ).resolves.toEqual({
      images: [
        {
          url: "private/marketplace/offers/copied-media-id/original-safe.webp",
          mediaObjectId: "copied-media-id",
        },
      ],
    });
  });

  it("promotes a restored remote offer photo to the canonical hotel cover", async () => {
    const sourceUrl = "https://images.example/restored-offer.webp";
    const mediaObjectId = "00000000-0000-4000-8000-000000000009";
    const galleryMedia = {
      mediaObjectId: "00000000-0000-4000-8000-000000000010",
      mediaType: "gallery_image",
      url: "https://cdn.example/hotels/gallery.webp",
      altText: "Hotel courtyard",
      sortOrder: 1,
    } as const;
    let publicProfileReads = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === sourceUrl) {
        expect(init).toEqual({ credentials: "omit" });
        return new Response(new Blob(["hotel-cover"], { type: "image/webp" }), { status: 200 });
      }
      if (href.endsWith("/api/media/upload-sessions")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          idempotencyKey: expect.stringMatching(
            /^marketplace\.property-hero:property-two:revision:17:files:sha256:[0-9a-f]{64}$/,
          ),
          purpose: "property.hero_image",
          visibility: "private",
          resource: {
            product: "hotel_catalog",
            resourceType: "property",
            resourceId: propertyId,
          },
        });
        expect(body).not.toHaveProperty("expectedProfileRevision");
        return jsonResponse({
          uploadSession: { sessionId: "cover-session" },
          uploadTargets: [
            {
              uploadTargetId: "cover-target",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/cover-target",
              headers: {},
            },
          ],
        });
      }
      if (href.endsWith("/api/media/upload-sessions/cover-session/finalize")) {
        return jsonResponse({
          mediaObjects: [
            {
              mediaId: mediaObjectId,
              storageKey: "private/media/hotel-cover.webp",
              contentType: "image/webp",
              sizeBytes: 11,
              originalFilename: "shared-hotel-photo-1.webp",
              variants: [
                {
                  publicCdnUrl: null,
                  storageKey: "private/media/hotel-cover.webp",
                },
              ],
            },
          ],
        });
      }
      if (href.endsWith(`/api/hotel-setup/properties/${propertyId}/public-profile`)) {
        publicProfileReads += 1;
        return jsonResponse({
          propertyId,
          profileRevision: publicProfileReads === 1 ? 17 : 18,
          publicProfile: {
            locale: "en",
            shortDescription: "A welcoming independent hotel.",
            longDescription: null,
            media:
              publicProfileReads === 1
                ? [publicProfile.publicProfile.media[0], galleryMedia]
                : [
                    {
                      mediaObjectId,
                      mediaType: "hero_image",
                      url: "https://cdn.example/hotels/cover.webp",
                      altText: null,
                      sortOrder: 0,
                    },
                    galleryMedia,
                  ],
          },
        });
      }
      if (href.endsWith(`/api/hotel-setup/properties/${propertyId}/media/presentation`)) {
        expect(init?.method).toBe("PUT");
        expect(requestHeader(init, "Idempotency-Key")).toBe(
          `marketplace.property-cover.assign:${propertyId}:revision:17:media:${mediaObjectId}`,
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedProfileRevision: 17,
          assignments: [
            { mediaObjectId, role: "cover", altText: null, sortOrder: 0 },
            {
              mediaObjectId: galleryMedia.mediaObjectId,
              role: "gallery",
              altText: galleryMedia.altText,
              sortOrder: 1,
            },
          ],
        });
        return jsonResponse({
          outcome: "updated",
          profileRevision: 18,
          logoAssignment: null,
          presentationAssignments: [
            { mediaObjectId, role: "cover", altText: null, sortOrder: 0 },
            {
              mediaObjectId: galleryMedia.mediaObjectId,
              role: "gallery",
              altText: galleryMedia.altText,
              sortOrder: 1,
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      hotelService.uploadProfileImageFromSource(sourceUrl, propertyId, 17),
    ).resolves.toMatchObject({
      mediaObjectId,
      url: "https://cdn.example/hotels/cover.webp",
    });
    expect(publicProfileReads).toBe(2);
  });

  it("classifies a browser-blocked canonical photo before starting a media upload", async () => {
    const sourceUrl = "https://images.example/no-cors.jpg";
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      hotelService.uploadListingImagesFromSources([sourceUrl], [], "offer-resource-id"),
    ).rejects.toEqual(new CanonicalHotelPhotoReuseError(sourceUrl));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(sourceUrl, { credentials: "omit" });
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
