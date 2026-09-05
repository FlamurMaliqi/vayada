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
  authenticateSyntheticPmsUser,
  createSyntheticPlatformAdmin,
  createSyntheticUser,
  fillSecret,
  futureStay,
  loadSmokeEnvironment,
  login,
  numberField,
  readAuthSession,
  record,
  recordField,
  smokeRecoveryReceipt,
  stringField,
  targetApi,
  uploadPropertyCover,
  type SmokeEnvironment,
  type SyntheticPlatformAdmin,
  type SyntheticUser,
} from "./support";
import { runQuoteLifecycle, waitForOffer, type BookingResource } from "./booking-lifecycle";
import { runPromotionAcceptance } from "./promotions";
import { cleanupSmokeResources, recoverSmokeProperty, type HotelResource } from "./cleanup";
import { configureGuestPolicyForManualBooking } from "./guest-policy";
import { replayAmbiguousManualBooking, runManualBookingAcceptance } from "./manual-booking";
import {
  confirmStaffInvitationDelivery,
  expectPms,
  runRestrictedStaffAcceptance,
} from "./restricted-staff";
import { replayAmbiguousUiBooking, runRoomShuffleAcceptance } from "./room-shuffle";

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

test("API error responses redact configured secrets", async () => {
  const previousPassword = process.env.NEXT_STACK_SMOKE_PASSWORD;
  const previousWorkosKey = process.env.WORKOS_API_KEY;
  const password = ["response", "password", "sentinel", "value"].join("/");
  const workosKey = ["sk", "test", "response", "sentinel"].join("_");
  const bearer = ["dynamic", "access", "sentinel"].join(".");
  process.env.NEXT_STACK_SMOKE_PASSWORD = password;
  process.env.WORKOS_API_KEY = workosKey;
  const request = {} as APIRequestContext;
  const respond = () =>
    Promise.resolve(
      new Response(
        `password=${encodeURIComponent(password)} key=${Buffer.from(workosKey).toString("base64")} authorization=${encodeURIComponent(`Bearer ${bearer}`)} token=${bearer}`,
        { status: 500 },
      ),
    );

  try {
    const api = new JsonApi(request, "https://example.test", `Bearer ${bearer}`, respond);
    await expect(api.json("POST", "/resource")).rejects.toThrow(
      "POST /resource returned 500: password=[REDACTED] key=[REDACTED] authorization=[REDACTED] token=[REDACTED]",
    );
  } finally {
    if (previousPassword === undefined) delete process.env.NEXT_STACK_SMOKE_PASSWORD;
    else process.env.NEXT_STACK_SMOKE_PASSWORD = previousPassword;
    if (previousWorkosKey === undefined) delete process.env.WORKOS_API_KEY;
    else process.env.WORKOS_API_KEY = previousWorkosKey;
  }
});

test("secret input avoids value-bearing Playwright steps", async ({ page }) => {
  const secret =
    process.env.NEXT_STACK_SMOKE_PASSWORD ?? ["synthetic", "evidence", "secret"].join("-");
  await page.setContent(`
    <label>Password <input type="password" /></label>
    <output>0</output>
    <script>
      document.querySelector("input").addEventListener("input", (event) => {
        document.querySelector("output").textContent = String(event.target.value.length);
      });
    </script>
  `);

  await fillSecret(page.getByLabel("Password"), secret);

  expect(await page.locator("output").textContent()).toBe(String(secret.length));
});

test("ambiguous UI booking replay registers the exact request for cleanup", async () => {
  const originalError = new Error("browser response timed out"),
    body = { commandId: "same-command", idempotencyKey: "same-key" },
    bookings: BookingResource[] = [];
  let replayedBody: unknown;
  const api = {
    async json(_method: string, _path: string, requestBody: unknown) {
      replayedBody = requestBody;
      return { guestBookingId: "booking-1" };
    },
  } as unknown as JsonApi;

  await expect(
    replayAmbiguousUiBooking(
      { api, bookings, slug: "synthetic-hotel" },
      "/api/pms/properties/property-1/manual-bookings",
      body,
      "synthetic@example.test",
      originalError,
    ),
  ).rejects.toBe(originalError);
  expect(replayedBody).toBe(body);
  expect(bookings).toEqual([
    {
      bookingId: "booking-1",
      email: "synthetic@example.test",
      mode: "instant",
      resolved: false,
      slug: "synthetic-hotel",
    },
  ]);
});

test("ambiguous UI booking replay exposes recovery failure without false registration", async () => {
  const originalError = new Error("browser response timed out"),
    replayError = new Error("idempotent replay failed"),
    bookings: BookingResource[] = [],
    api = {
      async json() {
        throw replayError;
      },
    } as unknown as JsonApi;

  const failure = await replayAmbiguousUiBooking(
    { api, bookings, slug: "synthetic-hotel" },
    "/api/pms/properties/property-1/manual-bookings",
    { commandId: "same-command", idempotencyKey: "same-key" },
    "synthetic@example.test",
    originalError,
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([originalError, replayError]);
  expect(bookings).toEqual([]);
});

test("staff delivery accepts an exact provider-confirmed delivered invitation", () => {
  expect(
    confirmStaffInvitationDelivery({
      delivery: "delivered",
      providerInvitationId: "invitation_exact",
    }),
  ).toBe("invitation_exact");
});

test("staff delivery resolves an ambiguous API outcome from exact provider evidence", () => {
  expect(
    confirmStaffInvitationDelivery({
      delivery: "unknown",
      providerInvitationId: "invitation_exact",
    }),
  ).toBe("invitation_exact");
});

test("staff delivery fails when provider confirmation errors", () => {
  const providerError = new Error("provider unavailable");
  const failure = (() => {
    try {
      confirmStaffInvitationDelivery({
        delivery: "unknown",
        providerInvitationId: "",
        providerLookupError: providerError,
      });
    } catch (error) {
      return error;
    }
  })();

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([providerError]);
});

test("staff delivery rejects non-delivery outcomes", () => {
  expect(() =>
    confirmStaffInvitationDelivery({
      delivery: "not_ready",
      providerInvitationId: "invitation_exact",
    }),
  ).toThrow("Unexpected staff invitation delivery outcome: not_ready");
});

test("ambiguous primary manual booking returns the exact idempotent replay", async () => {
  const body = { commandId: "same-command", idempotencyKey: "same-key" };
  let replayedBody: unknown;
  const api = {
    async json(_method: string, _path: string, requestBody: unknown) {
      replayedBody = requestBody;
      return { guestBookingId: "booking-1", outcome: "replayed" };
    },
  } as unknown as JsonApi;

  await expect(
    replayAmbiguousManualBooking(
      api,
      "/api/pms/properties/property-1/manual-bookings",
      body,
      new Error("browser response timed out"),
    ),
  ).resolves.toEqual({ guestBookingId: "booking-1", outcome: "replayed" });
  expect(replayedBody).toBe(body);
});

test("ambiguous primary manual booking exposes replay failure", async () => {
  const originalError = new Error("browser response timed out");
  const replayError = new Error("idempotent replay failed");
  const api = {
    async json() {
      throw replayError;
    },
  } as unknown as JsonApi;

  const failure = await replayAmbiguousManualBooking(
    api,
    "/api/pms/properties/property-1/manual-bookings",
    { commandId: "same-command", idempotencyKey: "same-key" },
    originalError,
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([originalError, replayError]);
});

test("cleanup refreshes hotel authentication before PMS fallback", async () => {
  const environment: SmokeEnvironment = {
    emailDomain: "example.test",
    password: "synthetic-password",
    runId: "20260903123456-deadbeef",
    workosApiKey: "sk_test_synthetic",
  };
  const owner: SyntheticUser = {
    id: "hotel-owner",
    email: "hotel-owner@example.test",
    firstName: "Hotel",
    lastName: "Owner",
    role: "hotel",
  };
  const decoy: SyntheticUser = {
    ...owner,
    id: "other-hotel-owner",
    email: "other-hotel-owner@example.test",
  };
  const booking: BookingResource = {
    bookingId: "booking-1",
    email: "guest@example.test",
    mode: "instant",
    resolved: false,
    slug: "synthetic-hotel",
  };
  const calls: string[] = [];
  const targetCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    if (url.origin === NEXT_STACK_ORIGINS.api) {
      expect(init?.headers).toMatchObject({ authorization: "Bearer fresh-access-token" });
      calls.push("target");
      targetCalls.push(`${method} ${url.pathname}`);
      return jsonResponse({});
    }
    if (url.pathname === "/user_management/users" && method === "GET") {
      return jsonResponse({ data: [] });
    }
    if (url.pathname === "/user_management/organization_memberships" && method === "GET") {
      return jsonResponse({ data: [] });
    }
    if (url.pathname.startsWith("/user_management/users/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected test request: ${method} ${url}`);
  }) as typeof globalThis.fetch;
  const request = {
    async post(url: string, options: unknown) {
      calls.push("login");
      expect(url).toBe(`${NEXT_STACK_ORIGINS.pms}/auth/password/login`);
      expect(options).toEqual({
        headers: { origin: NEXT_STACK_ORIGINS.pms },
        data: { email: owner.email, password: environment.password, surface: "pms-web" },
      });
      return {
        ok: () => true,
        text: async () => JSON.stringify({ accessToken: "fresh-access-token" }),
      };
    },
    async fetch(url: string, options: { data?: unknown; method?: string }) {
      calls.push("public");
      expect({ url, ...options }).toMatchObject({
        url: `${NEXT_STACK_ORIGINS.api}/api/booking-web/hotels/${booking.slug}/bookings/${booking.bookingId}/cancel`,
        method: "POST",
        data: { guestEmail: booking.email },
      });
      return {
        ok: () => false,
        status: () => 409,
        text: async () => JSON.stringify({ message: "Cancellation policy conflict." }),
      };
    },
  } as unknown as APIRequestContext;

  try {
    const errors = await cleanupSmokeResources(
      request,
      environment,
      [decoy, owner],
      [booking],
      {
        api: {
          async json() {
            throw new Error("Expired hotel API must not be reused.");
          },
        } as unknown as JsonApi,
        ownerWorkosUserId: owner.id,
        propertyId: "property-1",
      },
    );
    expect(errors).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(booking.resolved).toBe(true);
  expect(calls.slice(0, 4)).toEqual(["login", "public", "target", "target"]);
  expect(targetCalls).toEqual([
    "POST /api/pms/properties/property-1/reservations/booking-1/cancel",
    "PATCH /api/finance/properties/property-1/payment-settings",
  ]);
});

test("ordinary cleanup reconciles an untracked synthetic booking before retirement", async () => {
  const runId = "20260831123456-deadbeef";
  const propertyId = "11111111-1111-4111-8111-111111111111";
  const environment: SmokeEnvironment = {
    emailDomain: "example.test",
    password: "synthetic-password",
    runId,
    workosApiKey: "sk_test_synthetic",
  };
  const platformAdmin: SyntheticPlatformAdmin = {
    accessToken: "initial-token",
    email: `qa-next-platform-${runId}@example.test`,
    membershipId: "membership-platform",
    userId: "user-platform",
  };
  const calls: string[] = [];
  const bookings: BookingResource[] = [];
  let platformAdminDeleted = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/platform/admin/bookings/recover-next-stack-smoke") {
      calls.push(`recover:${String(init?.body)}`);
      return jsonResponse({ outcome: "resolved", bookings: ["untracked-booking"] });
    }
    if (url.pathname === `/api/platform/admin/properties/${propertyId}/retirement-impact`) {
      calls.push("retirement-impact");
      return jsonResponse({ lifecycleRevision: 7, lifecycleStatus: "active" });
    }
    if (url.pathname === `/api/platform/admin/properties/${propertyId}/retire`) {
      calls.push("retire");
      return jsonResponse({ lifecycleStatus: "retired" });
    }
    if (url.pathname === "/user_management/users" && method === "GET") {
      const isPlatformAdmin = url.searchParams.get("email") === platformAdmin.email;
      return jsonResponse({
        data:
          isPlatformAdmin && !platformAdminDeleted
            ? [{ email: platformAdmin.email, id: platformAdmin.userId }]
            : [],
      });
    }
    if (url.pathname === "/user_management/organization_memberships" && method === "GET") {
      return jsonResponse({ data: [] });
    }
    if (url.pathname === `/user_management/users/${platformAdmin.userId}` && method === "DELETE") {
      platformAdminDeleted = true;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected test request: ${method} ${url}`);
  }) as typeof globalThis.fetch;
  const request = {
    async post() {
      return {
        ok: () => true,
        status: () => 200,
        text: async () => JSON.stringify({ accessToken: "fresh-token" }),
      };
    },
  } as unknown as APIRequestContext;

  try {
    const replayFailure = await replayAmbiguousManualBooking(
      {
        async json() {
          throw new Error("replay response also timed out");
        },
      } as unknown as JsonApi,
      `/api/pms/properties/${propertyId}/manual-bookings`,
      { commandId: "same-command", idempotencyKey: "same-key" },
      new Error("browser response timed out after commit"),
    ).catch((error: unknown) => error);
    expect(replayFailure).toBeInstanceOf(AggregateError);
    expect(bookings).toEqual([]);

    const errors = await cleanupSmokeResources(
      request,
      environment,
      [],
      bookings,
      undefined,
      platformAdmin,
      [propertyId],
    );
    expect(errors).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(calls.map((call) => call.split(":", 1)[0])).toEqual([
    "recover",
    "retirement-impact",
    "retire",
  ]);
  expect(JSON.parse(calls[0]!.slice("recover:".length))).toEqual({
    emailDomain: environment.emailDomain,
    propertyId,
    recoveryReceipt: smokeRecoveryReceipt(environment, runId, propertyId),
    runId,
  });
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
    const registerHotel = (resource: HotelResource, retirementPropertyId = resource.propertyId) => {
      smokeResources.hotel = resource;
      retirementPropertyIds.push(retirementPropertyId);
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
  registerHotel: (resource: HotelResource, retirementPropertyId?: string) => void,
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
      page.getByRole("heading", { name: "Welcome to vayada — what brings you here?" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: /i manage a hotel/i }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("First name").fill(user.firstName);
    await page.getByLabel("Last name").fill(user.lastName);
    await page.getByLabel("Phone number").fill("+49 30 5550102");
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    await page.getByRole("button", { name: "Set up my first hotel" }).click();
    await expect(page.getByRole("heading", { name: "Choose how you’ll use vayada" })).toBeVisible();
    const result = await readAuthSession(page);
    expect(result.organizationKind).toBe("hotel_group");
    return result;
  });

  let api = targetApi(request, session.accessToken);
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
      registerHotel({
        api,
        ownerWorkosUserId: user.id,
        propertyId,
        workosOrganizationId: session.workosOrganizationId,
      });

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
        bookingBaseUrl: stringField(result, "bookingBaseUrl"),
        canonicalUrl: stringField(result, "canonicalUrl"),
        slug: stringField(result, "canonicalSlug"),
      };
      registerHotel({
        api,
        ownerWorkosUserId: user.id,
        propertyId: setup.propertyId,
        slug: published.slug,
        stay,
        workosOrganizationId: session.workosOrganizationId,
      });
      return published;
    });

  await test.step("open the published hotel and hand off to PMS and Booking Admin", async () => {
    const publishedHost = new URL(publication.bookingBaseUrl).hostname;
    expect(publishedHost).toBe(`${publication.slug}.next-booking.vayada.com`);
    const hostResponse = await request.get(
      `${NEXT_STACK_ORIGINS.api}/api/booking-web/hosts/${encodeURIComponent(publishedHost)}`,
    );
    expect(hostResponse).toBeOK();
    await expect(hostResponse.json()).resolves.toMatchObject({
      slug: publication.slug,
      hotel: { name: hotelName },
    });
    const profileResponse = await request.get(
      `${NEXT_STACK_ORIGINS.api}/api/booking-web/hotels/${encodeURIComponent(publication.slug)}`,
    );
    expect(profileResponse).toBeOK();
    await expect(profileResponse.json()).resolves.toMatchObject({
      hotel: { name: hotelName, slug: publication.slug },
    });
    const publicPage = await context.newPage();
    await publicPage.goto(publication.canonicalUrl);
    await expect(publicPage.getByRole("heading", { name: hotelName }).first()).toBeVisible();
    await expect(publicPage.getByRole("heading", { name: "Unable to Load Hotel" })).toHaveCount(0);
    await publicPage.close();

    await page.goto(`${NEXT_STACK_ORIGINS.marketplace}/marketplace`);
    await expect(
      page.getByRole("heading", { name: "vayada Marketplace", exact: true }),
    ).toBeVisible();
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
    ownerWorkosUserId: user.id,
    propertyId: setup.propertyId,
    slug: publication.slug,
    stay,
    workosOrganizationId: session.workosOrganizationId,
  };
  registerHotel(resource);
  await runPromotionAcceptance({
    api,
    bookings,
    environment,
    page,
    propertyId: setup.propertyId,
    request,
    roomTypeId: setup.roomTypeId,
    slug: publication.slug,
    stay,
  });
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
    refreshAuthentication: async () => {
      const accessToken = await authenticateSyntheticPmsUser(
        page.context().request,
        user,
        environment.password,
      );
      api = targetApi(request, accessToken);
      resource.api = api;
      return { accessToken, api };
    },
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

  const completedResource =
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
      const secondaryPropertyId = stringField(property, "propertyId");
      const completed = { ...resource, secondaryPropertyId };
      registerHotel(completed, secondaryPropertyId);
      return completed;
    });
  return completedResource;
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
  await expect(page.getByRole("heading", { name: "Choose how you’ll use vayada" })).toBeVisible();
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
    await expect(
      page.getByRole("heading", { name: "vayada Marketplace", exact: true }),
    ).toBeVisible();
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
  await expect(page.getByText(hotelName, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
