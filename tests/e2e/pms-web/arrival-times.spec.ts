import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

for (const initial of [false, true])
  test(`arrival windows ${initial ? "initialize policy" : "edit policy"} and survive a settings reload`, async ({
    page,
  }, testInfo) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    let choices = {
      defaultGuestLanguage: "en",
      childrenEnabled: false,
      adultAgeThreshold: null,
      phoneRequired: true,
      arrivalTimeEnabled: false,
      specialRequestsEnabled: true,
      checkInTime: "15:00",
      checkOutTime: "11:00",
      checkInUntil: "22:00",
      checkOutFrom: "07:00",
    };
    let revision = initial ? 0 : 3;
    const base = `**/api/booking/properties/${PMS_WEB_PROPERTY_ID}/booking-guest-policy`;
    const bundle = () => ({
      choices,
      propertyTimeZone: "Europe/Berlin",
      rates: [],
      sourceFingerprint: "sha256:test",
    });
    await page.route(base, async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        expect(body.expectedRevision).toBe(revision);
        expect(body.confirmPolicyBundle).toBe(true);
        expect(body.choices.phoneRequired).toBe(true);
        choices = body.choices;
        revision++;
        return route.fulfill({ json: { outcome: "updated", revision: { revision } } });
      }
      return route.fulfill({
        json: {
          propertyId: PMS_WEB_PROPERTY_ID,
          supportedLanguages: ["en", "de", "fr", "es", "id", "nl"],
          current: revision ? { revision, bundle: bundle() } : null,
          draft: revision
            ? null
            : { ...choices, defaultGuestLanguage: null, childrenEnabled: null },
        },
      });
    });
    await page.route(`${base}/preview`, (route) =>
      route.fulfill({
        json: {
          outcome: "ready",
          bundle: { ...bundle(), choices: route.request().postDataJSON().choices },
        },
      }),
    );
    await page.goto("/settings#booking-engine");
    if (initial) {
      await expect(page.getByLabel("Guests can check in from")).toHaveValue("15:00");
      await page.getByLabel("Default guest language").selectOption("en");
      await page.getByLabel("Are children welcome?").selectOption("false");
    }
    await page.getByLabel("Check-in until (optional)").fill("23:00");
    await page.getByRole("button", { name: "Review policy", exact: true }).click();
    const save = page.getByRole("button", { name: "Save arrival times", exact: true });
    await expect(save).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: "I have reviewed how these policies and guest charges will appear to guests.",
      })
      .check();
    await save.click();
    await expect(page.getByText("Arrival times saved.", { exact: false })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Check-in until (optional)")).toHaveValue("23:00");
    await expect(page.getByLabel("Guests must check out by")).toHaveValue("11:00");
    await page
      .locator("#booking-engine")
      .screenshot({ path: testInfo.outputPath("arrival-times.png") });
  });
