import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  type JsonApi,
} from "./support";
import { runQuoteLifecycle, waitForOffer, type BookingResource } from "./booking-lifecycle";
import { cleanupSmokeResources, recoverSmokeProperty, type HotelResource } from "./cleanup";
import { configureGuestPolicyForManualBooking } from "./guest-policy";
import { runManualBookingAcceptance } from "./manual-booking";

test("fresh hotel and creator onboarding reaches every next-stack handoff and safe checkout", async ({
  browser,
  request,
}, testInfo) => {
  test.skip(
    process.env.E2E_NEXT_STACK_SMOKE !== "1",
    "This live smoke must be acknowledged with E2E_NEXT_STACK_SMOKE=1.",
  );
  test.setTimeout(15 * 60_000);

  const environment = loadSmokeEnvironment();
  const { recoveryRunId, recoveryPropertyId, recoveryReceipt } = environment;
  if (recoveryRunId && recoveryPropertyId && recoveryReceipt) {
    await test.step("recover a failed synthetic property cleanup", () =>
      recoverSmokeProperty(request, environment, recoveryRunId, recoveryPropertyId));
    return;
  }
  const users: SyntheticUser[] = [];
  const bookings: BookingResource[] = [];
  let hotel: HotelResource | undefined;
  let platformAdmin: SyntheticPlatformAdmin | undefined;
  let primaryError: unknown;

  try {
    platformAdmin = await test.step("create temporary platform lifecycle approver", () =>
      createSyntheticPlatformAdmin(request, environment));
    const foreignHotelContext = await browser.newContext();
    let foreignAccessToken: string;
    try {
      foreignAccessToken = await runForeignHotelFlow(
        foreignHotelContext,
        request,
        environment,
        users,
      );
    } finally {
      await foreignHotelContext.close();
    }

    const hotelContext = await browser.newContext();
    try {
      hotel = await runHotelFlow(
        hotelContext,
        request,
        environment,
        users,
        bookings,
        foreignAccessToken,
        platformAdmin,
        testInfo,
        (resource) => {
          hotel = resource;
        },
      );
    } finally {
      await hotelContext.close();
    }

    const creatorContext = await browser.newContext();
    try {
      await runCreatorFlow(creatorContext, request, environment, users);
    } finally {
      await creatorContext.close();
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = await cleanupSmokeResources(
    request,
    environment,
    users,
    bookings,
    hotel,
    platformAdmin,
  );
  if (primaryError && cleanupErrors.length === 0) throw primaryError;
  if (cleanupErrors.length) {
    const failures = [primaryError, ...cleanupErrors].filter((error): error is unknown =>
      Boolean(error),
    );
    throw new AggregateError(
      failures,
      `Next-stack smoke failed; cleanup failures: ${cleanupErrors.length}; ${failures.map(errorMessage).join(" | ")}`,
    );
  }
});

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
): Promise<HotelResource> {
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
      await test.step("exercise deployed Financials writes, reads, OTA settings and receipts", () =>
        runFinancialsAcceptance(request, api, setup.propertyId, environment.runId));
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
      registerHotel({ api, propertyId: setup.propertyId, slug: published.slug, stay });
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

  const resource = {
    api,
    addonItemIds: [] as string[],
    propertyId: setup.propertyId,
    slug: publication.slug,
    stay,
  };
  registerHotel(resource);
  await configureGuestPolicyForManualBooking({
    api,
    accessToken: session.accessToken,
    propertyId: setup.propertyId,
    request,
    roomTypeId: setup.roomTypeId,
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

async function runFinancialsAcceptance(
  request: APIRequestContext,
  api: JsonApi,
  propertyId: string,
  runId: string,
): Promise<void> {
  const root = `/api/finance/properties/${propertyId}/financials`;
  const idempotency = (suffix: string) => `next-smoke:${runId}:financials:${suffix}`;
  await api.json("PATCH", `/api/pms/properties/${propertyId}/module-activations/financials`, {
    moduleId: "financials",
    isActive: true,
  });
  await api.json(
    "PUT",
    `/api/pms/properties/${propertyId}/pricing-source/currency`,
    { expectedPricingCurrencyRevision: 0, currency: "EUR" },
    { "Idempotency-Key": idempotency("pricing-currency") },
  );

  const categoryResponse = await api.json<Record<string, unknown>>(
    "POST",
    `${root}/expense-categories`,
    {
      commandId: randomUUID(),
      idempotencyKey: idempotency("category"),
      name: "QA staging acceptance",
      color: "#2946E8",
      sortOrder: 99,
    },
  );
  expect(categoryResponse.outcome).toBe("created");
  const categoryId = stringField(recordField(categoryResponse, "item"), "id");
  const expenseId = randomUUID();
  const receiptBytes = await readFile(
    path.resolve("apps/marketplace-web/public/creator-category-travel.jpg"),
  );
  const upload = await api.json<Record<string, unknown>>("POST", "/api/media/upload-sessions", {
    idempotencyKey: idempotency("receipt"),
    purpose: "finance.expense.receipt",
    visibility: "private",
    resource: {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
      propertyId,
      targetResourceId: expenseId,
    },
    files: [
      {
        clientFileId: "receipt_1",
        filename: `financials-${runId}.jpg`,
        contentType: "image/jpeg",
        sizeBytes: receiptBytes.length,
      },
    ],
  });
  const uploadSession = recordField(upload, "uploadSession");
  const target = record(arrayField(upload, "uploadTargets")[0]);
  const stored = await request.fetch(stringField(target, "uploadUrl"), {
    method: "PUT",
    headers: record(target.headers) as Record<string, string>,
    data: receiptBytes,
  });
  expect(stored.ok()).toBe(true);
  const finalized = await api.json<Record<string, unknown>>(
    "POST",
    `/api/media/upload-sessions/${stringField(uploadSession, "sessionId")}/finalize`,
    {
      files: [
        {
          uploadTargetId: stringField(target, "uploadTargetId"),
          contentType: "image/jpeg",
          sizeBytes: receiptBytes.length,
        },
      ],
    },
  );
  expect(JSON.stringify(finalized)).not.toMatch(/bucket|storageKey|checksumSha256|variants/);
  const receiptMediaId = stringField(recordField(finalized, "mediaObject"), "mediaObjectId");
  const incurredOn = new Date().toISOString().slice(0, 10);
  const expenseResponse = await api.json<Record<string, unknown>>(
    "POST",
    `${root}/expenses`,
    {
      commandId: expenseId,
      idempotencyKey: idempotency("expense"),
      incurredOn,
      vendor: "QA staging vendor",
      categoryId,
      amount: { amount: "12.3400", currency: "EUR" },
      paymentStatus: "unpaid",
      receiptMediaId,
    },
    { "Idempotency-Key": idempotency("expense") },
  );
  expect(expenseResponse).toMatchObject({
    outcome: "created",
    item: { id: expenseId, revision: 1 },
  });
  const expenseRead = await api.json<Record<string, unknown>>(
    "GET",
    `${root}/expenses/${expenseId}`,
  );
  expect(expenseRead).toMatchObject({ item: { id: expenseId } });
  const receipt = await api.json<Record<string, unknown>>(
    "GET",
    `${root}/expenses/${expenseId}/receipt`,
  );
  expect(JSON.stringify(receipt)).not.toMatch(/bucket|storageKey/);
  const disposition = recordField(recordField(receipt, "receipt"), "disposition");
  expect((await request.get(stringField(disposition, "url"))).ok()).toBe(true);

  const recurringId = randomUUID();
  const recurringResponse = await api.json<Record<string, unknown>>(
    "POST",
    `${root}/expenses`,
    {
      commandId: recurringId,
      idempotencyKey: idempotency("recurring"),
      incurredOn,
      vendor: "QA recurring vendor",
      categoryId,
      amount: { amount: "25.0000", currency: "EUR" },
      paymentStatus: "unpaid",
      recurrence: { cadence: "monthly", startsOn: incurredOn },
    },
    { "Idempotency-Key": idempotency("recurring") },
  );
  expect(recurringResponse).toMatchObject({ outcome: "created", item: { id: recurringId } });
  expect(
    await api.json<Record<string, unknown>>("GET", `${root}/recurring-expenses/${recurringId}`),
  ).toMatchObject({ item: { id: recurringId, active: true } });

  const otaRoot = `${root}/ota-commission-settings`;
  const otaBefore = await api.json<Record<string, unknown>>("GET", otaRoot);
  expect(arrayField(otaBefore, "settings")).toHaveLength(4);
  const ota = await api.json<Record<string, unknown>>("PUT", `${otaRoot}/booking_com`, {
    commandId: randomUUID(),
    idempotencyKey: idempotency("ota"),
    effectiveFrom: new Date().toISOString(),
    expectedRevision: 0,
    percentageRate: "14.25",
  });
  expect(ota).toMatchObject({ outcome: "created", setting: { percentageRate: "14.2500" } });
}

async function runForeignHotelFlow(
  context: BrowserContext,
  request: APIRequestContext,
  environment: SmokeEnvironment,
  users: SyntheticUser[],
): Promise<string> {
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
  await api.json(
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
  return session.accessToken;
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
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(NEXT_STACK_ORIGINS.marketplace)}`));
  await page.getByTitle("Switch app").click();
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return [...error.errors].map(errorMessage).join(" + ");
  }
  return error instanceof Error ? error.message : String(error);
}
