import { expect, test, type Page } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

test.use({ timezoneId: "America/Los_Angeles" });

test("creator selects one compensation option when applying", async ({ page }) => {
  await primeCreatorSession(page);
  await mockCreatorProfile(page);
  await routeJson(page, /\/api\/marketplace\/offers(?:\?|$)/, {
    items: [
      {
        offerId: "offer-application-e2e",
        offerPublicId: "offer-application-public-e2e",
        offerTitle: "Alpine creator stay",
        offerSummary: "Create a city guide for our hotel.",
        hotelName: "Marketplace Alpenrose",
        hotelSlug: "marketplace-alpenrose",
        hotelAccommodationType: "hotel",
        hotelLocation: { displayText: "Innsbruck, Austria", countryCode: "AT" },
        hotelCoverImageUrl: null,
        hotelImageUrls: [],
        deliverables: [],
        compensationOptions: [
          {
            compensationOptionId: "compensation-free-stay",
            compensationType: "free_stay",
            availabilityMonths: ["January"],
            platforms: ["instagram"],
            freeStayMinNights: 2,
            freeStayMaxNights: 3,
            paidMaxAmount: null,
            currency: null,
            discountPercentage: null,
            commissionPercentage: null,
            minFollowers: null,
            termsSummary: null,
          },
          {
            compensationOptionId: "compensation-paid",
            compensationType: "paid",
            availabilityMonths: ["September"],
            platforms: ["youtube"],
            freeStayMinNights: null,
            freeStayMaxNights: null,
            paidMaxAmount: "900",
            currency: "EUR",
            discountPercentage: null,
            commissionPercentage: null,
            minFollowers: null,
            termsSummary: null,
          },
        ],
        creatorRequirements: {
          platforms: ["instagram", "youtube"],
          targetCountries: ["AT", "DE"],
          targetAgeMin: null,
          targetAgeMax: null,
          targetAgeGroups: null,
          creatorTypes: ["travel"],
        },
        createdAt: "2026-07-01T10:00:00.000Z",
        projectedAt: "2026-07-01T10:00:00.000Z",
      },
    ],
    pagination: { limit: 200, offset: 0, total: 1 },
  });

  let submittedApplication: Record<string, unknown> | null = null;
  let submissionAttempts = 0;
  let releaseFirstSubmission!: () => void;
  const firstSubmissionGate = new Promise<void>((resolve) => {
    releaseFirstSubmission = resolve;
  });
  await page.route(/\/api\/marketplace\/collaborations$/, async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    if (method !== "POST") {
      await route.continue();
      return;
    }
    submissionAttempts += 1;
    submittedApplication = route.request().postDataJSON() as Record<string, unknown>;
    if (submissionAttempts === 1) {
      await firstSubmissionGate;
      await route.fulfill({
        status: 409,
        headers: corsHeaders(route),
        json: {
          code: "invalid_transition",
          category: "conflict",
          message: "An active collaboration already exists for this offer.",
        },
      });
      return;
    }
    const idempotencyKey = String(submittedApplication.idempotencyKey);
    await route.fulfill({
      status: 201,
      headers: corsHeaders(route),
      json: {
        contractVersion: "marketplace-collaboration-lifecycle-writes.v1",
        command: { action: "create", idempotencyKey },
        collaboration: {
          contractVersion: "marketplace-collaboration-reads.v1",
          authorizationMode: "creator_workspace_resource_link",
          collaborationId: "collaboration-application-e2e",
          offerId: "offer-application-e2e",
          creatorId: "creator-profile-e2e",
          hotelProfileId: "hotel-profile-e2e",
          side: "creator",
          initiatorSide: "creator",
          isInitiator: true,
          status: "pending",
          compensationType: "paid",
          offerTitle: "Alpine creator stay",
          hotelLocation: "Innsbruck, Austria",
          creator: {
            side: "creator",
            organizationId: "22222222-2222-4222-8222-222222222222",
            profileId: "creator-profile-e2e",
            displayName: "Lina Creator",
            avatarUrl: "https://media.example/lina.png",
            location: "Berlin, Germany",
            portfolioUrl: "https://example.test/lina",
            creatorType: "travel",
            platforms: [],
          },
          hotel: {
            side: "hotel",
            organizationId: "33333333-3333-4333-8333-333333333333",
            profileId: "hotel-profile-e2e",
            displayName: "Marketplace Alpenrose",
            avatarUrl: null,
          },
          terms: {
            freeStayMinNights: null,
            freeStayMaxNights: null,
            paidAmount: "900",
            currency: "EUR",
            discountPercentage: null,
            affiliateEnabled: false,
            affiliateCommissionPercentage: null,
            travelDateFrom: null,
            travelDateTo: null,
            preferredDateFrom: null,
            preferredDateTo: null,
            preferredMonths: [],
          },
          deliverables: [],
          lastMessageAt: null,
          createdAt: "2026-07-21T10:00:00.000Z",
          updatedAt: "2026-07-21T10:00:00.000Z",
        },
        sideEffects: [],
      },
    });
  });

  await page.goto("/marketplace");
  await expect(page.getByText("Board", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Apply for Collaboration" })).toBeVisible();

  const compensationRadios = page.getByRole("radio");
  await expect(compensationRadios).toHaveCount(2);
  const [freeStayRow, paidRow] = await Promise.all([
    compensationRadios.nth(0).locator("..").boundingBox(),
    compensationRadios.nth(1).locator("..").boundingBox(),
  ]);
  expect(freeStayRow).not.toBeNull();
  expect(paidRow).not.toBeNull();
  if (!freeStayRow || !paidRow) throw new Error("Compensation choices were not rendered");
  expect(Math.abs(freeStayRow.x - paidRow.x)).toBeLessThan(2);
  expect(paidRow.y).toBeGreaterThan(freeStayRow.y + freeStayRow.height);

  await expect(page.getByText(/Stay length offered: 2–3 nights/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Jan", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Sep", exact: true })).toBeEnabled();

  const paidChoice = page.getByRole("radio", { name: /Paid/ });
  await paidChoice.locator("..").click();
  await expect(paidChoice).toBeChecked();
  await expect(page.getByText(/Stay length offered:/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Jan", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sep", exact: true })).toBeEnabled();

  const fromDate = page.locator('input[type="date"]').first();
  await fromDate.fill("2027-09-01");
  await page.getByRole("button", { name: "Sep", exact: true }).click();
  await page
    .getByRole("radio", { name: /Free Stay/ })
    .locator("..")
    .click();
  await expect(fromDate).toHaveValue("");
  await paidChoice.locator("..").click();
  await expect(page.getByRole("button", { name: "Sep", exact: true })).not.toHaveClass(
    /bg-primary-600/,
  );

  await page
    .getByPlaceholder(/Share your content style, audience demographics/)
    .fill("My audience is a strong match for this city guide.");
  await page.getByText("YouTube", { exact: true }).last().click();
  const youtubeVideoRow = page.getByText("YouTube Video", { exact: true }).locator("..");
  await youtubeVideoRow.getByRole("button").last().click();
  await fromDate.fill("2027-01-10");
  const contactConsent = page.getByRole("checkbox", {
    name: /I consent to sharing my contact information with the hotel/,
  });
  await expect(contactConsent).not.toBeChecked();
  await contactConsent.locator("..").click();
  await expect(contactConsent).toBeChecked();
  await page.getByRole("button", { name: "Submit Application" }).click();

  const availabilityError = page.getByText(
    "The hotel is not available in: Jan. Please select dates within their availability.",
  );
  await expect(availabilityError).toBeVisible();
  await page.waitForTimeout(600);
  expect(submittedApplication).toBeNull();

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(availabilityError).toHaveCount(0);

  await page.getByRole("radio", { name: /Paid/ }).locator("..").click();
  await page
    .getByPlaceholder(/Share your content style, audience demographics/)
    .fill("My audience is a strong match for this city guide.");
  const september = page.getByRole("button", { name: "Sep", exact: true });
  await september.click();
  await page.getByRole("button", { name: "Select YouTube deliverables" }).click();
  await page.getByRole("button", { name: "Increase YouTube Video quantity" }).click();
  await expect(september).toHaveClass(/bg-primary-600/);
  await expect(contactConsent).not.toBeChecked();
  await page.locator('input[type="date"]').first().fill("2027-09-01");
  await page.getByText(/I consent to sharing my contact information/).click();
  await expect(contactConsent).toBeChecked();
  const submitApplication = page.getByRole("button", { name: "Submit Application" });
  const applicationDialog = page.getByRole("dialog", { name: "Apply for Collaboration" });
  await expect(submitApplication).toBeEnabled();
  await submitApplication.click();
  await expect(applicationDialog.getByRole("button", { name: "Loading..." })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(applicationDialog).toBeVisible();
  releaseFirstSubmission();

  const duplicateDialog = page.getByRole("dialog", { name: "Duplicate Application" });
  await expect(duplicateDialog).toBeVisible();
  await expect(applicationDialog).toHaveAttribute("inert", "");
  const closeDuplicateDialog = duplicateDialog.getByRole("button", { name: "Close" });
  const confirmDuplicateDialog = duplicateDialog.getByRole("button", { name: "OK" });
  await expect(closeDuplicateDialog).toBeFocused();
  await confirmDuplicateDialog.focus();
  await page.keyboard.press("Tab");
  await expect(closeDuplicateDialog).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirmDuplicateDialog).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(duplicateDialog).toHaveCount(0);

  await expect(applicationDialog).toBeVisible();
  await expect(applicationDialog).not.toHaveAttribute("inert");
  await expect(submitApplication).toBeFocused();
  await expect(
    page.getByPlaceholder(/Share your content style, audience demographics/),
  ).toHaveValue("My audience is a strong match for this city guide.");
  await submitApplication.click();

  await expect.poll(() => submittedApplication).not.toBeNull();
  await expect.poll(() => submissionAttempts).toBe(2);
  expect(submittedApplication).not.toHaveProperty("creatorId");
  expect(submittedApplication).not.toHaveProperty("initiatorSide");
  expect(submittedApplication).toMatchObject({
    offerId: "offer-application-e2e",
    compensationOptionId: "compensation-paid",
    whyGreatFit: "My audience is a strong match for this city guide.",
    consent: true,
    terms: {
      compensationType: "paid",
      paidAmount: "900",
      currency: "EUR",
      affiliateEnabled: false,
      travelDateFrom: "2027-09-01",
    },
    deliverables: [{ platform: "YouTube", type: "YouTube Video", quantity: 1 }],
  });
  const successDialog = page.getByRole("dialog", { name: "Application Sent!" });
  await expect(successDialog).toBeVisible();
  const closeSuccessDialog = successDialog.getByRole("button", { name: "Close" });
  const continueFromSuccess = successDialog.getByRole("button", { name: "Continue" });
  await expect(closeSuccessDialog).toBeFocused();
  await continueFromSuccess.focus();
  await page.keyboard.press("Tab");
  await expect(closeSuccessDialog).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(continueFromSuccess).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(successDialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeFocused();
});

test("creator can navigate the hotel detail gallery", async ({ page }) => {
  await primeCreatorSession(page);
  await mockCreatorProfile(page);
  await routeJson(page, /\/api\/marketplace\/offers(?:\?|$)/, {
    items: [
      {
        offerId: "offer-gallery-e2e",
        offerPublicId: "offer-gallery-public-e2e",
        offerTitle: "Gallery hotel",
        offerSummary: "A two-image creator stay.",
        hotelName: "Gallery hotel",
        hotelSlug: "gallery-hotel",
        hotelAccommodationType: "hotel",
        hotelLocation: { displayText: "Berlin, Germany", countryCode: "DE" },
        hotelCoverImageUrl: "/missing-gallery-image.jpg",
        hotelImageUrls: ["/missing-gallery-image.jpg", "/creator-category-lifestyle.jpg"],
        deliverables: [],
        compensationOptions: [
          {
            compensationOptionId: "gallery-free-stay",
            compensationType: "free_stay",
            availabilityMonths: ["September"],
            platforms: ["instagram"],
            freeStayMinNights: 2,
            freeStayMaxNights: 2,
            paidMaxAmount: null,
            currency: null,
            discountPercentage: null,
            commissionPercentage: null,
            minFollowers: null,
            termsSummary: null,
          },
        ],
        creatorRequirements: null,
        createdAt: "2026-07-01T10:00:00.000Z",
        projectedAt: "2026-07-01T10:00:00.000Z",
      },
    ],
    pagination: { limit: 200, offset: 0, total: 1 },
  });

  await page.goto("/marketplace");
  await expect(page.getByAltText("Gallery hotel - Image 1")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next image" })).toBeVisible();
  await page.getByRole("button", { name: "Next image" }).click();
  await expect(page.getByAltText("Gallery hotel - Image 2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Go to image 2" })).toHaveAttribute(
    "aria-current",
    "true",
  );

  const detailsButton = page.getByRole("button", { name: "Details", exact: true });
  await detailsButton.click();

  const dialog = page.getByRole("dialog", { name: "Gallery hotel" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Board Type", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Meal plan included", { exact: true })).toHaveCount(0);
  const closeButton = dialog.getByRole("button", { name: "Close hotel details" });
  await expect(closeButton).toBeFocused();
  await expect(dialog.getByAltText("Gallery hotel - Image 1")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Next detail image" })).toBeVisible();

  const firstFocusable = dialog.getByRole("button", { name: "Previous detail image" });
  const lastFocusable = dialog.getByRole("button", { name: "Apply for Collaboration" });
  await lastFocusable.focus();
  await page.keyboard.press("Tab");
  await expect(firstFocusable).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(lastFocusable).toBeFocused();

  await dialog.getByRole("button", { name: "Next detail image" }).click();
  await expect(dialog.getByAltText("Gallery hotel - Image 2")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Show detail image 2" })).toHaveAttribute(
    "aria-current",
    "true",
  );

  await dialog.getByRole("button", { name: "Show detail image 1" }).click();
  await expect(dialog.getByRole("button", { name: "Show detail image 1" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(dialog.getByRole("button", { name: "Next detail image" })).toBeVisible();

  const detailDialogElement = page.locator('[role="dialog"][aria-labelledby="hotel-detail-title"]');
  const applyFromDetails = dialog.getByRole("button", { name: "Apply for Collaboration" });
  await applyFromDetails.click();

  const applicationDialog = page.getByRole("dialog", { name: "Apply for Collaboration" });
  await expect(applicationDialog).toBeVisible();
  await expect(detailDialogElement).toHaveAttribute("inert", "");
  const closeApplication = applicationDialog.getByRole("button", { name: "Close application" });
  const cancelApplication = applicationDialog.getByRole("button", { name: "Cancel" });
  const fitInput = applicationDialog.getByPlaceholder(
    /Share your content style, audience demographics/,
  );
  await expect(closeApplication).toBeFocused();
  await cancelApplication.focus();
  await page.keyboard.press("Tab");
  await expect(closeApplication).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancelApplication).toBeFocused();
  await fitInput.fill("This should be cleared when the modal closes.");
  await page.keyboard.press("Escape");
  await expect(applicationDialog).toHaveCount(0);
  await expect(detailDialogElement).not.toHaveAttribute("inert");
  await expect(applyFromDetails).toBeFocused();

  await applyFromDetails.click();
  const reopenedApplicationDialog = page.getByRole("dialog", {
    name: "Apply for Collaboration",
  });
  await expect(reopenedApplicationDialog).toBeVisible();
  await expect(
    reopenedApplicationDialog.getByPlaceholder(/Share your content style, audience demographics/),
  ).toHaveValue("");
  await reopenedApplicationDialog.locator("..").click({ position: { x: 2, y: 2 } });
  await expect(reopenedApplicationDialog).toHaveCount(0);
  await expect(detailDialogElement).not.toHaveAttribute("inert");
  await expect(applyFromDetails).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(detailsButton).toBeFocused();
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
