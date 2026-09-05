import { expect, test, type Page } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

test("creator edits a pending request, retries failures, and cancels it", async ({ page }) => {
  await primeCreatorSession(page);
  await mockCreatorProfile(page);
  let collaboration = {
    contractVersion: "marketplace-collaboration-reads.v1",
    authorizationMode: "creator_workspace_resource_link",
    collaborationId: "request-953",
    offerId: "offer-953",
    creatorId: "creator-profile-e2e",
    hotelProfileId: "hotel-953",
    side: "creator",
    initiatorSide: "creator",
    isInitiator: true,
    status: "pending",
    compensationType: "paid",
    propertyTimezone: "Europe/Berlin",
    offerTitle: "Creator stay",
    hotelLocation: "Berlin",
    applicationMessage: "Original pitch",
    selectedCompensationOptionId: "paid-953",
    creator: {
      side: "creator",
      organizationId: "creator-org",
      profileId: "creator-profile-e2e",
      displayName: "Lina Creator",
      avatarUrl: null,
      location: "Berlin",
      portfolioUrl: null,
      creatorType: "travel",
      platforms: [],
    },
    hotel: {
      side: "hotel",
      organizationId: "hotel-org",
      profileId: "hotel-953",
      displayName: "Berlin Hotel",
      avatarUrl: null,
    },
    terms: {
      paidAmount: "900",
      currency: "EUR",
      freeStayMinNights: null,
      freeStayMaxNights: null,
      discountPercentage: null,
      affiliateEnabled: false,
      affiliateCommissionPercentage: null,
      travelDateFrom: "2027-09-01",
      travelDateTo: "2027-09-03",
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredMonths: [],
    },
    deliverables: [
      {
        deliverableId: "d-953",
        platform: "Instagram",
        type: "Reel",
        quantity: 1,
        status: "pending",
        completedAt: null,
      },
      {
        deliverableId: "story-953",
        platform: "Instagram",
        type: "Story",
        quantity: 3,
        status: "pending",
        completedAt: null,
      },
    ],
    createdAt: "2026-09-01T01:00:00.000Z",
    updatedAt: "2026-09-05T01:00:00.000Z",
    lastMessageAt: null,
    cancelledBy: null as string | null,
  };
  await routeJson(page, /\/api\/marketplace\/offers(?:\?|$)/, {
    items: [
      {
        offerId: "offer-953",
        offerPublicId: "offer-public-953",
        offerTitle: "Creator stay",
        offerSummary: "A creator visit",
        hotelName: "Berlin Hotel",
        hotelSlug: "berlin-hotel",
        hotelAccommodationType: "hotel",
        hotelLocation: { displayText: "Berlin", countryCode: "DE" },
        hotelCoverImageUrl: null,
        hotelImageUrls: [],
        deliverables: [],
        creatorRequirements: null,
        compensationOptions: [
          {
            compensationOptionId: "paid-953",
            compensationType: "paid",
            availabilityMonths: [],
            platforms: [],
            paidMaxAmount: "900",
            currency: "EUR",
            freeStayMinNights: null,
            freeStayMaxNights: null,
            discountPercentage: null,
            commissionPercentage: null,
          },
        ],
        createdAt: collaboration.createdAt,
        projectedAt: collaboration.updatedAt,
      },
    ],
    pagination: { total: 1, offset: 0, limit: 200 },
  });
  await page.route(/\/api\/marketplace\/collaborations\/me(?:\?|$)/, (route) =>
    route.fulfill({ headers: corsHeaders(route), json: { items: [collaboration] } }),
  );
  await routeJson(page, /\/api\/marketplace\/collaborations\/conversations(?:\?|$)/, {
    items: [],
    nextCursor: null,
    hasMore: false,
  });
  await page.route(/\/api\/marketplace\/collaborations\/request-953(?:\?|$)/, (route) =>
    route.fulfill({ headers: corsHeaders(route), json: collaboration }),
  );
  let edits = 0;
  await page.route(/\/collaborations\/request-953\/application$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    edits++;
    const body = route.request().postDataJSON();
    expect(body.expectedUpdatedAt).toBe("2026-09-05T01:00:00.000Z");
    expect(body.compensationOptionId).toBe("paid-953");
    expect(body.deliverables).toMatchObject([
      { platform: "Instagram", type: "Reel", quantity: 1 },
      { platform: "Instagram", type: "Story", quantity: 3 },
    ]);
    if (edits === 1)
      return route.fulfill({
        status: 500,
        headers: corsHeaders(route),
        json: { message: "Save failed" },
      });
    collaboration = {
      ...collaboration,
      applicationMessage: body.whyGreatFit,
      updatedAt: "2026-09-05T02:00:00.000Z",
    };
    return route.fulfill({ headers: corsHeaders(route), json: { collaboration } });
  });
  let cancels = 0;
  await page.route(/\/collaborations\/request-953\/cancel$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    cancels++;
    expect(route.request().postDataJSON().pendingOnly).toBe(true);
    if (cancels === 1)
      return route.fulfill({
        status: 500,
        headers: corsHeaders(route),
        json: { message: "Cancel failed" },
      });
    collaboration = { ...collaboration, status: "cancelled", cancelledBy: "creator" };
    return route.fulfill({ headers: corsHeaders(route), json: { collaboration } });
  });
  await page.goto("/chat");
  await page.getByRole("button", { name: /^Sent/ }).click();
  await page.getByText("Berlin Hotel", { exact: true }).click();
  await page.getByRole("button", { name: "Edit Request", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Request", exact: true });
  const pitch = dialog.locator("textarea");
  await expect(pitch).toHaveValue("Original pitch");
  await pitch.fill("Updated pitch");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog.getByText("Save failed", { exact: true })).toBeVisible();
  await expect(pitch).toHaveValue("Updated pitch");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Updated pitch", { exact: true })).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel Request" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Cancel failed" })).toHaveText(
    "Cancel failed",
  );
  await expect(page.getByRole("button", { name: "Edit Request" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel Request" }).click();
  await expect(page.getByText("Cancelled by creator", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Request" })).toHaveCount(0);
});

async function primeCreatorSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("userType", "creator");
    localStorage.setItem("userName", "Lina Creator");
    localStorage.setItem("isLoggedIn", "true");
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
  });
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "creator-authkit-token",
        csrfToken: "creator-csrf-token",
        organizationId: "22222222-2222-4222-8222-222222222222",
        organizationKind: "creator_workspace",
        user: {
          id: "user-creator-e2e",
          email: "creator@example.test",
          name: "Lina Creator",
          phone: "+49 89 123456",
          status: "active",
        },
      },
    });
  });
}

async function mockCreatorProfile(page: Page) {
  await routeJson(page, /\/api\/marketplace\/creators\/me(?:\?|$)/, {
    creatorProfileId: "creator-profile-e2e",
    displayName: "Lina Creator",
    creatorType: "travel",
    locationText: "Berlin, Germany",
    shortDescription: "I create practical city guides for independent travelers.",
    portfolioUrl: "https://creator.example/portfolio",
    phone: "+49 89 123456",
    profilePictureUrl: "https://media.example/lina.png",
    profilePictureMediaObjectId: "media-lina",
    profileComplete: true,
    profileStatus: "active",
    platforms: [
      {
        platformId: "platform-instagram",
        platform: "instagram",
        handle: "@lina",
        profileUrl: "https://instagram.com/lina",
        followerCount: 1200,
        engagementRate: 4.2,
        audienceCountries: [],
        audienceAgeGroups: [],
        audienceGenderSplit: null,
      },
      {
        platformId: "platform-youtube",
        platform: "youtube",
        handle: "@linatravels",
        profileUrl: "https://youtube.com/@linatravels",
        followerCount: 800,
        engagementRate: 3.8,
        audienceCountries: [],
        audienceAgeGroups: [],
        audienceGenderSplit: null,
      },
    ],
    audienceSize: 2000,
    rating: { averageRating: 0, totalReviews: 0 },
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
  });
  await routeJson(page, /\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, {
    profilePhotoRequired: true,
    profileComplete: true,
    missingFields: [],
    missingPlatforms: false,
    completionSteps: [],
  });
}

async function routeJson(page: Page, pattern: RegExp, json: unknown) {
  await page.route(pattern, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({ status: 200, headers: corsHeaders(route), json });
  });
}
