import { expect, test, type APIRequestContext } from "@playwright/test";

type CanaryConfig = {
  expectedBuildSha: string | null;
  expectedHotelName: string;
  slug: string;
  timeoutMs: number;
  url: URL;
};

test("published next-booking tenant stays publicly reachable", async ({ page, request }) => {
  test.skip(
    process.env.E2E_BOOKING_PUBLIC_CANARY !== "1",
    "Set E2E_BOOKING_PUBLIC_CANARY=1 to acknowledge the deployed public canary.",
  );

  const config = loadCanaryConfig();
  test.setTimeout(config.timeoutMs + 90_000);

  await expect
    .poll(() => deployedBuildIsReady(request, config), {
      message: config.expectedBuildSha
        ? `Booking Web did not expose build ${config.expectedBuildSha} before the canary deadline.`
        : "Booking Web health did not become ready before the canary deadline.",
      timeout: config.timeoutMs,
      intervals: [2_000, 5_000, 10_000],
    })
    .toBe(true);

  const hostResponse = await request.get(
    new URL(`/api/booking-web/hosts/${encodeURIComponent(config.url.hostname)}`, config.url.origin)
      .href,
  );
  expect(hostResponse, await responseFailure("host resolution", hostResponse)).toBeOK();
  const host = await hostResponse.json();
  expect(host).toMatchObject({
    contractVersion: "public-bookability.v1",
    hotel: {
      name: config.expectedHotelName,
      slug: config.slug,
    },
  });

  const profileResponse = await request.get(
    new URL(`/api/booking-web/hotels/${encodeURIComponent(config.slug)}`, config.url.origin).href,
  );
  expect(profileResponse, await responseFailure("hotel profile", profileResponse)).toBeOK();
  const profile = await profileResponse.json();
  expect(profile).toMatchObject({
    contractVersion: "public-bookability.v1",
    hotel: {
      name: config.expectedHotelName,
      slug: config.slug,
    },
  });

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const pageResponse = await page.goto(config.url.href, { waitUntil: "domcontentloaded" });
  expect(pageResponse, "Booking Web tenant page did not return an HTTP response.").not.toBeNull();
  expect(
    pageResponse?.ok(),
    `Booking Web tenant page returned HTTP ${pageResponse?.status()}.`,
  ).toBe(true);
  await expect(page.getByRole("link", { name: config.expectedHotelName }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("heading", { name: "Unable to Load Hotel" })).toHaveCount(0);
  expect(pageErrors, `Booking Web raised browser exceptions:\n${pageErrors.join("\n")}`).toEqual(
    [],
  );
});

function loadCanaryConfig(): CanaryConfig {
  const rawUrl = required("BOOKING_PUBLIC_CANARY_URL");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".next-booking.vayada.com")) {
    throw new Error(
      "BOOKING_PUBLIC_CANARY_URL must be an HTTPS tenant on *.next-booking.vayada.com.",
    );
  }

  const slug = url.hostname.slice(0, -".next-booking.vayada.com".length);
  if (!slug || slug.includes(".")) {
    throw new Error("BOOKING_PUBLIC_CANARY_URL must contain exactly one tenant slug subdomain.");
  }

  const rawTimeout = process.env.BOOKING_PUBLIC_CANARY_TIMEOUT_MS || "60000";
  const timeoutMs = Number(rawTimeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 900_000) {
    throw new Error("BOOKING_PUBLIC_CANARY_TIMEOUT_MS must be between 10000 and 900000.");
  }

  return {
    expectedBuildSha: process.env.BOOKING_PUBLIC_CANARY_EXPECTED_BUILD_SHA?.trim() || null,
    expectedHotelName: required("BOOKING_PUBLIC_CANARY_NAME"),
    slug,
    timeoutMs,
    url,
  };
}

async function deployedBuildIsReady(
  request: APIRequestContext,
  config: CanaryConfig,
): Promise<boolean> {
  try {
    const response = await request.get(new URL("/api/health", config.url.origin).href, {
      failOnStatusCode: false,
      timeout: 15_000,
    });
    if (!response.ok()) return false;
    const body = (await response.json()) as { buildSha?: unknown; status?: unknown };
    return (
      body.status === "ok" &&
      (!config.expectedBuildSha || body.buildSha === config.expectedBuildSha)
    );
  } catch {
    return false;
  }
}

async function responseFailure(
  label: string,
  response: { status(): number; text(): Promise<string> },
) {
  return `${label} returned HTTP ${response.status()}: ${(await response.text()).slice(0, 500)}`;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
