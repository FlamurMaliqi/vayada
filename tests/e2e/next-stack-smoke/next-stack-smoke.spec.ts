import path from "node:path";

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";

import {
  JsonApi,
  NEXT_STACK_ORIGINS,
  arrayField,
  createSyntheticPlatformAdmin,
  createSyntheticUser,
  futureStay,
  loadSmokeEnvironment,
  login,
  numberField,
  readAuthSession,
  record,
  recordField,
  stringField,
  targetApi,
  uploadPropertyCover,
  type SmokeEnvironment,
  type SyntheticPlatformAdmin,
  type SyntheticUser,
} from "./support";
import { runQuoteLifecycle, waitForOffer, type BookingResource } from "./booking-lifecycle";
import { cleanupSmokeResources, recoverSmokeProperty, type HotelResource } from "./cleanup";
import { configureGuestPolicyForManualBooking } from "./guest-policy";
import { runManualBookingAcceptance } from "./manual-booking";
import { expectPms, runRestrictedStaffAcceptance } from "./restricted-staff";
import { runRoomShuffleAcceptance } from "./room-shuffle";

type ForeignHotelResource = { accessToken: string; propertyId: string };
type HotelFlowResource = HotelResource & {
  ownerWorkosUserId: string;
  secondaryPropertyId: string;
  workosOrganizationId: string;
};
type SmokeResources = {
  bookings: BookingResource[];
  environment?: SmokeEnvironment;
  hotel?: HotelResource;
  platformAdmin?: SyntheticPlatformAdmin;
  retirementPropertyIds: string[];
  users: SyntheticUser[];
};

const smokeTest = test.extend<{ smokeResources: SmokeResources }>({
  smokeResources: [
    async ({ request }, use) => {
      const resources: SmokeResources = {
        bookings: [],
        retirementPropertyIds: [],
        users: [],
      };
      await use(resources);
      if (!resources.environment) return;

      const errors = await cleanupSmokeResources(
        request,
        resources.environment,
        resources.users,
        resources.bookings,
        resources.hotel,
        resources.platformAdmin,
        resources.retirementPropertyIds,
      );
      if (errors.length) {
        throw new AggregateError(
          errors,
          `Next-stack smoke cleanup failed: ${errors.map(errorMessage).join(" | ")}`,
        );
      }
    },
    { timeout: 5 * 60_000 },
  ],
});

test("API transport failures do not expose authorization", async () => {
  const secret = ["sk", "test", "FAKESECRET"].join("_");
  const failure = new Error(`authorization: Bearer ${secret}`);
  const fail = () => Promise.reject(failure);
  const request = { fetch: fail } as unknown as APIRequestContext;
  const api = new JsonApi(request, "https://example.test", `Bearer ${secret}`, fail);

  await expect(api.json("GET", "/resource")).rejects.toThrow(/^GET \/resource request failed\.$/);
  await expect(api.deleteIfPresent("/resource")).rejects.toThrow(
    /^DELETE \/resource request failed\.$/,
  );
  await expect(expectPms(secret, "/resource", 200, undefined, fail)).rejects.toThrow(
    /^GET \/resource request failed\.$/,
  );
});

smokeTest(
  "fresh hotel and creator onboarding reaches every next-stack handoff and safe checkout",
  async ({ browser, request, smokeResources }, testInfo) => {
    smokeTest.skip(
      process.env.E2E_NEXT_STACK_SMOKE !== "1",
      "This live smoke must be acknowledged with E2E_NEXT_STACK_SMOKE=1.",
    );
    smokeTest.setTimeout(15 * 60_000);

    const environment = loadSmokeEnvironment();
    const { recoveryRunId, recoveryPropertyId, recoveryReceipt } = environment;
    if (recoveryRunId && recoveryPropertyId && recoveryReceipt) {
      await test.step("recover a failed synthetic property cleanup", () =>
        recoverSmokeProperty(request, environment, recoveryRunId, recoveryPropertyId));
      return;
    }
    smokeResources.environment = environment;
    const { users, bookings, retirementPropertyIds } = smokeResources;

    const platformAdmin = await test.step("create temporary platform lifecycle approver", () =>
      createSyntheticPlatformAdmin(request, environment));
    smokeResources.platformAdmin = platformAdmin;
    const foreignHotelContext = await browser.newContext();
    let foreignHotel: ForeignHotelResource;
    try {
      foreignHotel = await runForeignHotelFlow(foreignHotelContext, request, environment, users);
    } finally {
      await foreignHotelContext.close();
    }
    retirementPropertyIds.push(foreignHotel.propertyId);
    const registerHotel = (resource: HotelResource): void => {
      smokeResources.hotel = resource;
      retirementPropertyIds.push(resource.propertyId);
    };

    const hotelContext = await browser.newContext();
    try {
      const completedHotel = await runHotelFlow(
        hotelContext,
        request,
        environment,
        users,
        bookings,
        foreignHotel.accessToken,
        platformAdmin,
        testInfo,
        registerHotel,
      );
      const staff = await test.step("create a unique verified staff identity", async () => {
        const created = await createSyntheticUser(request, environment, "staff");
        users.push(created);
        return created;
      });
      await runRestrictedStaffAcceptance({
        assignedPropertyId: completedHotel.propertyId,
        browser,
        environment,
        foreignPropertyId: foreignHotel.propertyId,
        ownerApi: completedHotel.api,
        ownerWorkosOrganizationId: completedHotel.workosOrganizationId,
        ownerWorkosUserId: completedHotel.ownerWorkosUserId,
        replacementPropertyId: completedHotel.secondaryPropertyId,
        request,
        staff,
      });
    } finally {
      await hotelContext.close();
    }

    const creatorContext = await browser.newContext();
    try {
      await runCreatorFlow(creatorContext, request, environment, users);
    } finally {
      await creatorContext.close();
    }
  },
);

async function runHotelFlow(
  context: BrowserContext,
  request: APIRequestContext,
  environment: SmokeEnvironment,
  users: SyntheticUser[],
  bookings: BookingResource[],
  foreignAccessToken: string,
  platformAdmin: SyntheticPlatformAdmin,
  testInfo: TestInfo,
  registerHotel: (resource: HotelResource) => void,
): Promise<HotelFlowResource> {
  const page = await context.newPage();
  const user = await test.step("create a unique verified hotel identity", async () => {
    const created = await createSyntheticUser(request, environment, "hotel");
    users.push(created);
    return created;
  });

  const session = await test.step("complete hotel account onboarding in Marketplace", async () => {
    await login(page, user, environment.password);
    await acceptNecessaryCookies(page);
    await expect(
      page.getByRole("heading", { name: "Welcome to Vayada — what brings you here?" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: /i manage a hotel/i }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("First name").fill(user.firstName);
    await page.getByLabel("Last name").fill(user.lastName);
    await page.getByLabel("Phone number").fill("+49 30 5550102");
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    await page.getByRole("button", { name: "Set up my first hotel" }).click();
    await expect(page.getByRole("heading", { name: "Choose how you’ll use Vayada" })).toBeVisible();
    const result = await readAuthSession(page);
    expect(result.organizationKind).toBe("hotel_group");
    return result;
  });

  const api = targetApi(request, session.accessToken);
  const hotelName = `QA Next Hotel ${environment.runId}`;
  const setup =
    await test.step("provision tracks, hotel profile, commission, payment and room", async () => {
      await api.json(
        "PUT",
        "/api/hotel-setup/tracks",
        {
          selectedTracks: ["hotel_operations", "creator_marketplace"],
          expectedRevision: 0,
        },
        { "Idempotency-Key": `next-smoke:${environment.runId}:tracks` },
      );

      const property = await api.json<Record<string, unknown>>(
        "POST",
        "/api/hotel-setup/properties",
        {
          displayName: hotelName,
          propertyType: "hotel",
          location: {
            streetAddress: "Alexanderplatz 1",
            postalCode: "10178",
            city: "Berlin",
            countryCode: "DE",
            timezone: "Europe/Berlin",
            latitude: null,
            longitude: null,
            localityPublic: true,
            geoPublic: false,
            mapDisplayMode: "hidden",
          },
          contacts: [
            { channelType: "email", value: user.email, purpose: "general", isPublic: false },
            { channelType: "phone", value: "+49 30 5550102", purpose: "general", isPublic: false },
          ],
        },
        { "Idempotency-Key": `next-smoke:${environment.runId}:property` },
      );
      const propertyId = stringField(property, "propertyId");
      registerHotel({ api, propertyId });

      await api.json("PUT", `/api/hotel-setup/properties/${propertyId}/launch-settings`, {
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR"],
        defaultLanguage: "en",
        supportedLanguages: ["en"],
        instagram: "",
        facebook: "",
        tiktok: "",
        youtube: "",
      });
      await api.json("POST", `/api/finance/properties/${propertyId}/select-commission`, {
        commandId: `next-smoke:${environment.runId}:commission`,
        idempotencyKey: `next-smoke:${environment.runId}:commission`,
      });
      await api.json("PATCH", `/api/finance/properties/${propertyId}/payment-settings`, {
        commandId: `next-smoke:${environment.runId}:payment`,
        idempotencyKey: `next-smoke:${environment.runId}:payment`,
        paymentSettings: {
          paymentsEnabled: true,
          paymentProvider: "manual",
          acceptedMethods: ["pay_at_property", "cash"],
          depositPolicy: {
            bankName: "",
            accountHolder: "",
            accountNumber: "",
            bicSwift: "",
            paypalEmail: "",
            paypalPaymentWindowHours: 24,
            bankTransferInstructions: "",
          },
          refundPolicy: { freeCancellationDays: 7 },
          requiresManualReview: false,
        },
      });
      const room = await api.json<Record<string, unknown>>(
        "POST",
        `/api/pms/properties/${propertyId}/room-types`,
        {
          onboardingSetup: true,
          initialSetupOnly: true,
          name: "QA Double Room",
          totalRooms: 2,
          maxOccupancy: 2,
          maxAdults: 2,
          maxChildren: 0,
          bedType: "1 King Bed",
          bedrooms: 1,
          bathrooms: 1,
          bathroomType: "private",
          size: 24,
          baseRate: "150.00",
          currency: "EUR",
          isActive: true,
          operatingPeriods: [{ from: "01-01", to: "12-31" }],
          seasons: [
            {
              name: "Year-round",
              tier: "standard",
              from: "01-01",
              to: "12-31",
              rate: "150.00",
              minStay: 1,
            },
          ],
          commandId: `next-smoke:${environment.runId}:room`,
          idempotencyKey: `next-smoke:${environment.runId}:room`,
        },
      );
      const roomTypeId = stringField(recordField(room, "item"), "roomTypeId");
      await api.json("PATCH", `/api/booking/hotels/${propertyId}/settings/property`, {
        check_in_time: "15:00",
        check_out_time: "12:00",
        terms_text: "Guests agree to the QA smoke terms. No real payment is collected.",
        cancellation_policy_text: "Free cancellation follows the selected flexible rate terms.",
      });
      return { propertyId, roomTypeId };
    });

  const stay = futureStay();
  const publication =
    await test.step("publish presentation and direct booking readiness", async () => {
      const uploaded = await uploadPropertyCover(request, api, setup.propertyId, environment.runId);
      const presentation = await api.json<Record<string, unknown>>(
        "GET",
        `/api/hotel-setup/properties/${setup.propertyId}/steps/present-hotel`,
      );
      await api.json(
        "PUT",
        `/api/hotel-setup/properties/${setup.propertyId}/steps/present-hotel`,
        {
          expectedProfileRevision: numberField(presentation, "profileRevision"),
          locale: "en",
          shortDescription:
            "A synthetic Berlin hotel used only to verify the deployed Vayada next-stack flow.",
          amenities: { reviewed: true, keys: ["wifi"] },
          media: { coverMediaObjectId: uploaded.mediaObjectId, galleryMediaObjectIds: [] },
        },
        { "Idempotency-Key": `next-smoke:${environment.runId}:presentation` },
      );
      const publicProfile = await api.json<Record<string, unknown>>(
        "GET",
        `/api/hotel-setup/properties/${setup.propertyId}/public-profile`,
      );
      const media = arrayField(recordField(publicProfile, "publicProfile"), "media").map(record);
      const hero = media.find((item) => item.mediaObjectId === uploaded.mediaObjectId);
      if (!hero) throw new Error("Published hotel presentation is missing its cover image.");
      const heroImage = stringField(hero, "url");
      await api.json("PATCH", `/api/booking/hotels/${setup.propertyId}/settings/design`, {
        heroImage,
        heroHeading: hotelName,
        heroSubtext: "Book this synthetic room without a card charge.",
        primaryColor: "#2946E8",
        fontPairing: "modern-minimalist",
      });
      const platformAdminApi = targetApi(request, platformAdmin.accessToken);
      const impact = await platformAdminApi.json<Record<string, unknown>>(
        "GET",
        `/api/platform/admin/properties/${setup.propertyId}/retirement-impact`,
      );
      expect(impact.lifecycleStatus).toBe("provisioning");
      const expectedLifecycleRevision = numberField(impact, "lifecycleRevision");
      const activation = await platformAdminApi.json<Record<string, unknown>>(
        "PATCH",
        `/api/platform/admin/properties/${setup.propertyId}/status`,
        {
          expectedLifecycleRevision,
          status: "active",
          reason: "Approve the isolated next-stack smoke property",
        },
        { "Idempotency-Key": `next-smoke:${environment.runId}:property-active` },
      );
      expect(activation).toMatchObject({
        lifecycleStatus: "active",
        lifecycleRevision: expectedLifecycleRevision + 1,
      });
      const result = await api.json<Record<string, unknown>>(
        "POST",
        `/api/booking/hotels/${setup.propertyId}/public-bookability`,
      );
      expect(result.profileStatus).toBe("public");
      expect(result.freshnessStatus).toBe("fresh");
      expect(arrayField(result, "missingReadiness")).toEqual([]);
      const published = {
        canonicalUrl: stringField(result, "canonicalUrl"),
        slug: stringField(result, "canonicalSlug"),
      };
      registerHotel({
        api,
        propertyId: setup.propertyId,
        slug: published.slug,
        stay,
      });
      return published;
    });

  await test.step("open the published hotel and hand off to PMS and Booking Admin", async () => {
    const publicPage = await context.newPage();
    await publicPage.goto(publication.canonicalUrl);
    await expect(publicPage.getByRole("heading", { name: hotelName }).first()).toBeVisible();
    await publicPage.close();

    await page.goto(`${NEXT_STACK_ORIGINS.marketplace}/marketplace`);
    await expect(page.getByRole("heading", { name: "Marketplace", exact: true })).toBeVisible();
    await assertMarketplaceHandoff(page, "Property Manager", NEXT_STACK_ORIGINS.pms, hotelName);
    await page.goto(`${NEXT_STACK_ORIGINS.marketplace}/marketplace`);
    await assertMarketplaceHandoff(
      page,
      "Booking Engine",
      NEXT_STACK_ORIGINS.bookingAdmin,
      hotelName,
    );
  });

  const secondaryPropertyId =
    await test.step("create a replacement property for restricted staff", async () => {
      const property = await api.json<Record<string, unknown>>(
        "POST",
        "/api/hotel-setup/properties",
        {
          displayName: `QA Restricted Hotel ${environment.runId}`,
          propertyType: "hotel",
          location: {
            streetAddress: "Unter den Linden 1",
            postalCode: "10117",
            city: "Berlin",
            countryCode: "DE",
            timezone: "Europe/Berlin",
            latitude: null,
            longitude: null,
            localityPublic: false,
            geoPublic: false,
            mapDisplayMode: "hidden",
          },
          contacts: [
            { channelType: "email", value: user.email, purpose: "general", isPublic: false },
            { channelType: "phone", value: "+49 30 5550104", purpose: "general", isPublic: false },
          ],
        },
        { "Idempotency-Key": `next-smoke:${environment.runId}:restricted-property` },
      );
      const propertyId = stringField(property, "propertyId");
      registerHotel({ api, propertyId });
      return propertyId;
    });

  const resource = {
    api,
    addonItemIds: [] as string[],
    ownerWorkosUserId: user.id,
    propertyId: setup.propertyId,
    secondaryPropertyId,
    slug: publication.slug,
    stay,
    workosOrganizationId: session.workosOrganizationId,
  };
  registerHotel(resource);
  await configureGuestPolicyForManualBooking({
    api,
    accessToken: session.accessToken,
    propertyId: setup.propertyId,
    request,
    roomTypeId: setup.roomTypeId,
  });
  await runRoomShuffleAcceptance({
    api,
    bookings,
    environment,
    page,
    propertyId: setup.propertyId,
    roomTypeId: setup.roomTypeId,
    slug: publication.slug,
    testInfo,
  });
  await runManualBookingAcceptance({
    api,
    accessToken: session.accessToken,
    bookings,
    environment,
    foreignAccessToken,
    page,
    propertyId: setup.propertyId,
    request,
    slug: publication.slug,
    testInfo,
    addonItemIds: resource.addonItemIds,
  });
  await test.step("exercise instant and request checkout with inventory restoration", async () => {
    for (const mode of ["instant", "request"] as const) {
      await api.json("PUT", `/api/pms/properties/${setup.propertyId}/booking-acceptance`, {
        acceptanceMode: mode,
      });
      const offer = await waitForOffer(request, publication.slug, stay, 2);
      expect(offer.roomTypeId).toBe(setup.roomTypeId);
      await runQuoteLifecycle(request, environment, publication.slug, stay, offer, mode, bookings);
      await waitForOffer(request, publication.slug, stay, 2);
    }
  });

  return resource;
}

async function runForeignHotelFlow(
  context: BrowserContext,
  request: APIRequestContext,
  environment: SmokeEnvironment,
  users: SyntheticUser[],
): Promise<ForeignHotelResource> {
  const page = await context.newPage();
  const user = await createSyntheticUser(request, environment, "hotel", "foreign");
  users.push(user);
  await login(page, user, environment.password);
  await acceptNecessaryCookies(page);
  await page.getByRole("radio", { name: /i manage a hotel/i }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("First name").fill(user.firstName);
  await page.getByLabel("Last name").fill(user.lastName);
  await page.getByLabel("Phone number").fill("+49 30 5550199");
  await page.getByRole("button", { name: "Continue to hotel setup" }).click();
  await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
  await page.getByRole("button", { name: "Set up my first hotel" }).click();
  await expect(page.getByRole("heading", { name: "Choose how you’ll use Vayada" })).toBeVisible();
  const session = await readAuthSession(page);
  expect(session.organizationKind).toBe("hotel_group");
  const api = targetApi(request, session.accessToken);
  await api.json(
    "PUT",
    "/api/hotel-setup/tracks",
    { selectedTracks: ["hotel_operations"], expectedRevision: 0 },
    { "Idempotency-Key": `next-smoke:${environment.runId}:foreign-tracks` },
  );
  const property = await api.json<Record<string, unknown>>(
    "POST",
    "/api/hotel-setup/properties",
    {
      displayName: `QA Foreign Hotel ${environment.runId}`,
      propertyType: "hotel",
      location: {
        streetAddress: "Potsdamer Platz 1",
        postalCode: "10785",
        city: "Berlin",
        countryCode: "DE",
        timezone: "Europe/Berlin",
        latitude: null,
        longitude: null,
        localityPublic: false,
        geoPublic: false,
        mapDisplayMode: "hidden",
      },
      contacts: [
        { channelType: "email", value: user.email, purpose: "general", isPublic: false },
        { channelType: "phone", value: "+49 30 5550199", purpose: "general", isPublic: false },
      ],
    },
    { "Idempotency-Key": `next-smoke:${environment.runId}:foreign-property` },
  );
  return { accessToken: session.accessToken, propertyId: stringField(property, "propertyId") };
}

async function runCreatorFlow(
  context: BrowserContext,
  request: APIRequestContext,
  environment: SmokeEnvironment,
  users: SyntheticUser[],
): Promise<void> {
  const page = await context.newPage();
  const user = await test.step("create a unique verified creator identity", async () => {
    const created = await createSyntheticUser(request, environment, "creator");
    users.push(created);
    return created;
  });

  await test.step("complete creator onboarding, submit review and enter Marketplace", async () => {
    await login(page, user, environment.password);
    await acceptNecessaryCookies(page);
    await page.getByRole("radio", { name: /i’m a creator/i }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("First name").fill(user.firstName);
    await page.getByLabel("Last name").fill(user.lastName);
    await page.getByLabel("Phone number").fill("+49 30 5550103");
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload profile photo" }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles(path.resolve("apps/marketplace-web/public/creator-category-travel.jpg"));
    await page.getByRole("button", { name: "Continue to creator profile" }).click();
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    const session = await readAuthSession(page);
    expect(session.organizationKind).toBe("creator_workspace");

    await page.getByRole("button", { name: "Create my public creator profile" }).click();
    await page.getByRole("button", { name: /^Lifestyle/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Location").fill("Berlin, Germany");
    await page
      .getByLabel("Creator bio")
      .fill("I create practical city guides for independent travelers and small hotels.");
    await page.getByLabel("Portfolio link").fill("https://example.com/qa-next-creator");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Enter Instagram account manually" }).click();
    await page.getByPlaceholder("@ username").fill(`@qa_next_${environment.runId.slice(-8)}`);
    await page.getByPlaceholder("0", { exact: true }).fill("1500");
    await page.getByPlaceholder("0.00").fill("4.20");
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByRole("heading", { name: "Your profile is complete" })).toBeVisible();
    await page.getByRole("button", { name: "Open marketplace" }).click();
    await expect(page).toHaveURL(/\/marketplace$/);
    await expect(page.getByRole("heading", { name: "Marketplace", exact: true })).toBeVisible();
  });
}

async function assertMarketplaceHandoff(
  page: Page,
  label: string,
  expectedOrigin: string,
  hotelName: string,
) {
  await expect(page).toHaveURL(`${NEXT_STACK_ORIGINS.marketplace}/marketplace`);
  const switcher = page
    .locator("aside")
    .getByRole("button", { name: /^(?:Switch app|Marketplace Creator collaborations)$/ });
  try {
    await switcher.click();
  } catch (error) {
    throw new Error(`Marketplace app switcher is unavailable at ${new URL(page.url()).pathname}.`, {
      cause: error,
    });
  }
  await page.getByRole("link", { name: new RegExp(label) }).click();
  await page.waitForURL((url) => url.origin === expectedOrigin && url.pathname === "/dashboard", {
    timeout: 45_000,
  });
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard", exact: true }).first()).toBeVisible();
  await expect(page.getByText(hotelName, { exact: true }).first()).toBeVisible();
}

async function acceptNecessaryCookies(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Necessary only" });
  if (await button.isVisible()) await button.click();
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return [...error.errors].map(errorMessage).join(" + ");
  }
  return error instanceof Error ? error.message : String(error);
}
