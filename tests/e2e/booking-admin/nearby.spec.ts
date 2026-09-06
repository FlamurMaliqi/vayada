import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  BOOKING_ADMIN_PROPERTY_PROFILE_PATH,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
  defaultBookingAdminPropertyProfile,
} from "../support/bookingAdminMocks";
const nearby = `/api/hotel-setup/properties/${BOOKING_ADMIN_PROPERTY_ID}/nearby`;
async function setup(page: Page, provider = true, sdk = "ready") {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await page.addInitScript((sdk) => {
    const target = window as unknown as {
      google: unknown;
      __nearbyMaps: unknown[];
      __nearbyWidgetMounts: number;
    };
    target.__nearbyMaps = [];
    target.__nearbyWidgetMounts = 0;
    class MapMock {
      setCenter() {}
      setZoom() {}
      constructor(element: HTMLElement, options: unknown) {
        target.__nearbyMaps.push(options);
        element.textContent = "Test map";
      }
    }
    class MarkerMock {
      constructor(_options: unknown) {}
      setMap() {}
      setPosition() {}
    }
    class PlaceMock extends HTMLElement {
      place = { location: { lat: () => 1, lng: () => 2 } };
      connectedCallback() {
        target.__nearbyWidgetMounts += 1;
        const id = this.querySelector("gmp-place-details-place-request")?.getAttribute("place");
        this.append(document.createTextNode(id === "beach" ? "Nearby beach" : "Nearby cafe"));
        queueMicrotask(() =>
          this.dispatchEvent(new Event(sdk === "fail" ? "gmp-error" : "gmp-load")),
        );
      }
    }
    customElements.define("gmp-place-details-compact", PlaceMock);
    target.google = {
      maps: {
        importLibrary: async (library: string) => {
          if (sdk === "hang") await new Promise(() => {});
          if (sdk === "late" && library === "places")
            await new Promise((resolve) => setTimeout(resolve, 10000));
          return library === "maps"
            ? { Map: MapMock, Circle: MarkerMock }
            : library === "marker"
              ? { Marker: MarkerMock }
              : {};
        },
      },
    };
  }, sdk);
  const profile = structuredClone(defaultBookingAdminPropertyProfile);
  profile.profile.location = {
    ...profile.profile.location,
    latitude: -1.125,
    longitude: 1.005,
    mapDisplayMode: "approximate",
    geoPublic: true,
  };
  let curation = {
    schemaVersion: 1,
    profileRevision: 1,
    curationRevision: 0,
    savedProfileRevision: null as number | null,
    choices: [] as unknown[],
    customPlaces: [] as unknown[],
  };
  let saveStatus = 200;
  await page.route(`**${BOOKING_ADMIN_PROPERTY_PROFILE_PATH}`, async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      profile.profile.location = body.patch.location;
      profile.profileRevision += 1;
      curation.profileRevision = profile.profileRevision;
    }
    await route.fulfill({ json: profile });
  });
  await page.route(`**${nearby}/curation`, async (route) => {
    if (route.request().method() === "PUT") {
      if (saveStatus !== 200)
        return route.fulfill({ status: saveStatus, json: { code: "revision_conflict" } });
      const body = route.request().postDataJSON();
      curation = {
        ...curation,
        choices: body.choices,
        customPlaces: body.customPlaces,
        curationRevision: curation.curationRevision + 1,
        savedProfileRevision: profile.profileRevision,
      };
    }
    await route.fulfill({ json: curation });
  });
  await page.route(`**${nearby}/refresh`, (route) =>
    route.fulfill(
      provider
        ? {
            json: {
              schemaVersion: 1,
              profileRevision: profile.profileRevision,
              status: "ready",
              places: [
                { placeId: "beach", category: "nature" },
                { placeId: "cafe", category: "food" },
              ],
              retryAfter: null,
            },
          }
        : { status: 503, json: { code: "not_configured" } },
    ),
  );
  return {
    failSave: (status: number) => {
      saveStatus = status;
    },
  };
}
async function addPlace(page: Page) {
  await page.getByRole("button", { name: "Add your own place" }).click();
  const form = page.getByRole("form", { name: "Add a custom place" });
  await form.getByLabel("Place name").fill("Our garden");
  await form.getByLabel(/^latitude$/i).fill("0");
  await form.getByLabel(/^longitude$/i).fill("0");
  await form.getByRole("button", { name: "Add place", exact: true }).click();
}
test("automatic suggestions, favorites, hiding and saved places survive reload", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/settings/location");
  await expect(page.getByRole("heading", { name: "Location & surroundings" })).toBeVisible();
  const nature = page.getByRole("region", { name: "Beaches & nature" });
  await expect(nature.getByText("Nearby beach")).toBeVisible();
  await nature.getByLabel("Favorite", { exact: true }).check();
  await page.getByRole("region", { name: "Food & drink" }).getByLabel("Hide from guests").check();
  await addPlace(page);
  await page.getByRole("button", { name: "Save places", exact: true }).click();
  await expect(page.getByText("Places saved.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(nature.getByLabel("Favorite", { exact: true }).first()).toBeChecked();
  await page.screenshot({ path: test.info().outputPath("editor.png"), fullPage: true });
  await page.getByRole("button", { name: "Preview guest view" }).click();
  await expect(page.getByText("Recommended by us", { exact: true })).toBeVisible();
  await expect(page.getByText("Our garden", { exact: true })).toBeVisible();
  await expect(page.getByText("Nearby cafe", { exact: true })).toHaveCount(0);
  const maps = await page.evaluate(
    () => (window as unknown as { __nearbyMaps: { center: unknown }[] }).__nearbyMaps,
  );
  await page.screenshot({ path: test.info().outputPath("preview.png"), fullPage: true });
  expect(maps.at(-1)?.center).toEqual({ lat: -1.13, lng: 1.01 });
});
test("provider failure still allows custom saves; failed/conflicting saves preserve edits", async ({
  page,
}) => {
  const state = await setup(page, false);
  await page.goto("/settings/location");
  await expect(page.getByText(/Automatic suggestions are unavailable/)).toBeVisible();
  await addPlace(page);
  for (const status of [503, 409]) {
    state.failSave(status);
    await page.getByRole("button", { name: "Save places", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "preserved" })).toBeVisible();
    await expect(page.getByText("Our garden", { exact: true })).toBeVisible();
  }
  state.failSave(200);
  await page.getByRole("button", { name: "Save places", exact: true }).click();
  await expect(page.getByText("Places saved.", { exact: true })).toBeVisible();
});
test("mobile editing, discard and navigation protection retain dirty forms", async ({ page }) => {
  await setup(page, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/location");
  await page.getByLabel("Street address", { exact: true }).fill("Changed street");
  await expect(page.getByLabel(/^latitude$/i)).toHaveValue("");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "Back to settings", exact: true }).click();
  await expect(page).toHaveURL(/settings\/location/);
  await expect(page.getByLabel("Street address", { exact: true })).toHaveValue("Changed street");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.reload({ timeout: 2000 }).catch(() => {});
  await expect(page.getByLabel("Street address", { exact: true })).toHaveValue("Changed street");
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByLabel("Street address", { exact: true })).not.toHaveValue(
    "Changed street",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test("saving a new location updates the revision and hidden preview suppresses destinations", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/settings/location");
  await page.getByLabel("Guest map visibility").selectOption("hidden");
  await page.getByRole("button", { name: "Save location", exact: true }).click();
  await expect(page.getByText(/Location saved/)).toBeVisible();
  await page.getByRole("button", { name: "Preview guest view" }).click();
  await expect(
    page.getByText("The map and nearby places are hidden from guests.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Map of our surroundings" })).toHaveCount(0);
});

test("an unfinished custom-place form cannot be lost by opening preview", async ({ page }) => {
  await setup(page, false);
  await page.goto("/settings/location");
  await page.getByRole("button", { name: "Add your own place" }).click();
  await page.getByLabel("Place name").fill("Unfinished garden");
  await expect(page.getByRole("button", { name: "Preview guest view" })).toBeDisabled();
  await expect(page.getByLabel("Place name")).toHaveValue("Unfinished garden");
});
test("fallback protects same-document back, forward and app navigation", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined }));
  await setup(page, false);
  await page.goto("/settings/location");
  await expect(page.getByLabel("Street address", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, "", "?step=1");
    history.pushState({}, "", "?step=2");
    history.back();
  });
  await expect(page).toHaveURL(/step=1/);
  await page.getByLabel("Street address", { exact: true }).fill("Keep this draft");
  for (const direction of ["back", "forward"] as const) {
    const dialog = page.waitForEvent("dialog");
    await page.evaluate((direction) => history[direction](), direction);
    await (await dialog).dismiss();
    await expect(page).toHaveURL(/step=1/);
    await expect(page.getByLabel("Street address", { exact: true })).toHaveValue("Keep this draft");
  }
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/step=1/);
});
test("late Google imports cannot mount cards after timeout", async ({ page }) => {
  await page.clock.install();
  await setup(page, true, "late");
  await page.goto("/settings/location");
  await expect(page.getByRole("heading", { name: "Beaches & nature" })).toBeVisible();
  await page.clock.runFor(11000);
  expect(
    await page.evaluate(
      () => (window as unknown as { __nearbyWidgetMounts: number }).__nearbyWidgetMounts,
    ),
  ).toBe(0);
  await expect(page.getByText(/Place details unavailable/).first()).toBeVisible();
});
test("a hung map loader reaches its readable fallback", async ({ page }) => {
  await page.clock.install();
  await setup(page, true, "hang");
  await page.goto("/settings/location");
  await page.getByRole("button", { name: "Preview guest view" }).click();
  await page.clock.runFor(9000);
  await expect(
    page.getByText("Map unavailable. Explore the places in the list below.", { exact: true }),
  ).toBeVisible();
});
test("failed preview cards do not automatically request replacements", async ({ page }) => {
  await setup(page, true, "fail");
  await page.route(`**${nearby}/refresh`, (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        profileRevision: 1,
        status: "ready",
        places: Array.from({ length: 7 }, (_, i) => ({
          placeId: `place_${i}`,
          category: "nature",
        })),
        retryAfter: null,
      },
    }),
  );
  await page.goto("/settings/location");
  await expect(page.getByText(/Place details unavailable/)).toHaveCount(7);
  await page.evaluate(() => {
    (window as unknown as { __nearbyWidgetMounts: number }).__nearbyWidgetMounts = 0;
  });
  await page.getByRole("button", { name: "Preview guest view" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __nearbyWidgetMounts: number }).__nearbyWidgetMounts,
      ),
    )
    .toBe(5);
  await page.getByRole("button", { name: "Show more beaches & nature" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __nearbyWidgetMounts: number }).__nearbyWidgetMounts,
      ),
    )
    .toBe(7);
});
