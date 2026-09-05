import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";
const payload = {
  schemaVersion: 1,
  status: "ready",
  location: { mode: "approximate", latitude: -1.13, longitude: 1.01 },
  places: [
    {
      source: "custom",
      id: "beach",
      name: "Our favorite beach",
      address: "Beach road",
      category: "nature",
      latitude: -1.14,
      longitude: 1.02,
      favorite: true,
      note: "Sunset is lovely here.",
    },
    { source: "google", placeId: "cafe", category: "food", favorite: false, note: null },
    {
      source: "custom",
      id: "museum",
      name: "Local museum",
      address: null,
      category: "activities",
      latitude: -1.12,
      longitude: 1.03,
      favorite: false,
      note: null,
    },
    {
      source: "custom",
      id: "airport",
      name: "Airport",
      address: null,
      category: "transport",
      latitude: 20,
      longitude: 30,
      favorite: false,
      note: null,
    },
  ],
};
async function setup(page: Page, mode = "ready") {
  await mockBookingApis(page);
  let requests = 0;
  await page.route("**/api/booking-web/hotels/hotel-alpenrose/nearby", (route) => {
    requests++;
    return route.fulfill(
      mode === "api-fail"
        ? { status: 503, json: {} }
        : {
            json:
              mode === "hidden"
                ? { schemaVersion: 1, status: "hidden", location: null, places: [] }
                : payload,
          },
    );
  });
  await page.addInitScript((mode) => {
    const target = window as unknown as {
      google: unknown;
      __nearbyImports: number;
      __nearbyCenters: unknown[];
    };
    target.__nearbyImports = 0;
    target.__nearbyCenters = [];
    class MapMock {
      constructor(
        public element: HTMLElement,
        options: { center: unknown },
      ) {
        target.__nearbyCenters.push(options.center);
      }
      setCenter() {
        throw new Error("Unexpected neighborhood recenter");
      }
      setZoom() {}
    }
    class MarkerMock {
      button?: HTMLButtonElement;
      constructor(private options: { map?: MapMock; title?: string; opacity?: number }) {}
      addListener(_event: string, click: () => void) {
        const button = document.createElement("button");
        button.textContent = this.options.title ?? "Marker";
        button.setAttribute("aria-label", `Map marker ${button.textContent}`);
        button.style.opacity = String(this.options.opacity ?? 1);
        button.onclick = click;
        this.options.map?.element.append(button);
        this.button = button;
        return { remove: () => button.remove() };
      }
      setMap(map: unknown) {
        if (!map) this.button?.remove();
      }
    }
    class PlaceMock extends HTMLElement {
      place = { location: { lat: () => -1.11, lng: () => 1.02 } };
      connectedCallback() {
        this.append(document.createTextNode("Cafe · Google attribution"));
        queueMicrotask(() => this.dispatchEvent(new Event("gmp-load")));
      }
    }
    customElements.define("gmp-place-details-compact", PlaceMock);
    target.google = {
      maps: {
        importLibrary: async (name: string) => {
          target.__nearbyImports++;
          if (mode === "map-fail" && name === "maps") throw new Error("Unavailable");
          return name === "maps"
            ? { Map: MapMock, Circle: MarkerMock }
            : name === "marker"
              ? { Marker: MarkerMock }
              : {};
        },
      },
    };
  }, mode);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Explore our surroundings" })).toBeVisible();
  return () => requests;
}
for (const mobile of [false, true])
  test(`lazy surroundings and keyboard map/list selection (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }, info) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const requests = await setup(page);
    expect(requests()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __nearbyImports: number }).__nearbyImports),
    ).toBe(0);
    await page.getByRole("button", { name: "Explore our surroundings" }).click();
    const section = page.getByRole("region", { name: "Our surroundings", exact: true });
    await expect(
      section.getByRole("heading", { name: "Our favorite beach", exact: true }),
    ).toBeVisible();
    await expect(section.getByText("Recommended by us", { exact: true })).toHaveCount(1);
    for (const category of ["Beaches & nature", "Food & drink", "Things to do", "Transport"])
      await expect(section.getByRole("heading", { name: category, exact: true })).toBeVisible();
    const select = section.getByRole("button", { name: /Highlight on map: Our favorite beach/ });
    await select.focus();
    await page.keyboard.press("Enter");
    await expect(select).toHaveAttribute("aria-pressed", "true");
    await section.getByRole("button", { name: "Map marker Airport", exact: true }).click();
    const airport = section.getByRole("button", { name: /Highlight on map: Airport/ });
    await expect(airport).toBeFocused();
    await expect(airport).toHaveAttribute("aria-pressed", "true");
    expect(
      await page.evaluate(
        () => (window as unknown as { __nearbyCenters: unknown[] }).__nearbyCenters,
      ),
    ).toEqual([{ lat: -1.13, lng: 1.01 }]);
    const directions = section.getByRole("link", { name: "Directions", exact: true });
    await expect(directions).toHaveCount(4);
    for (const href of await directions.evaluateAll((links) =>
      links.map((link) => (link as HTMLAnchorElement).href),
    )) {
      const url = new URL(href);
      expect(url.searchParams.has("origin")).toBe(false);
      expect(url.origin).toBe("https://www.google.com");
    }
    await expect(section.getByText("Cafe · Google attribution")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await section.screenshot({ path: info.outputPath("surroundings.png") });
  });
test("map failure keeps readable recommendations and room selection", async ({ page }) => {
  await setup(page, "map-fail");
  await page.getByRole("button", { name: "Explore our surroundings" }).click();
  await expect(
    page.getByText("Map unavailable. Explore the places in the list below."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Our favorite beach", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Select This Rate/i }).first()).toBeVisible();
});
test("hidden location never mounts Google or exposes directions", async ({ page }) => {
  await setup(page, "hidden");
  await page.getByRole("button", { name: "Explore our surroundings" }).click();
  await expect(page.getByText("Contact us for location details.")).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __nearbyImports: number }).__nearbyImports),
  ).toBe(0);
  await expect(page.getByRole("region", { name: "Map of our surroundings" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Directions", exact: true })).toHaveCount(0);
});
test("public API failure leaves booking usable", async ({ page }) => {
  await setup(page, "api-fail");
  await page.getByRole("button", { name: "Explore our surroundings" }).click();
  await expect(
    page.getByText("Surroundings are unavailable right now. You can still choose a room."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Select This Rate/i }).first()).toBeVisible();
});
test("a pending refresh can be checked without reloading the booking page", async ({ page }) => {
  await setup(page);
  let reads = 0;
  await page.route("**/api/booking-web/hotels/hotel-alpenrose/nearby", (route) =>
    route.fulfill({ json: { ...payload, status: reads++ === 0 ? "refreshing" : "ready" } }),
  );
  await page.getByRole("button", { name: "Explore our surroundings" }).click();
  await page.getByRole("button", { name: "Check for updated places" }).click();
  await expect(
    page.getByRole("heading", { name: "Our favorite beach", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Check for updated places" })).toHaveCount(0);
  expect(reads).toBe(2);
});
