import { expect, test } from "@playwright/test";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

test("hotel website validates and saves normalized canonical contacts", async ({ page }) => {
  const propertyId = "22222222-2222-4222-8222-222222222222";
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const profile = {
    propertyId,
    profileRevision: 1,
    profile: {
      displayName: "Hotel Alpenrose",
      propertyType: "hotel",
      location: {
        streetAddress: "Marienplatz 1",
        postalCode: "80331",
        city: "Munich",
        countryCode: "DE",
        timezone: "Europe/Berlin",
        latitude: null,
        longitude: null,
        localityPublic: true,
        geoPublic: false,
        mapDisplayMode: "hidden",
      },
      contacts: [
        {
          channelType: "website",
          value: "https://old.example",
          purpose: "general",
          isPublic: true,
        },
        { channelType: "phone", value: "+49 89 123456", purpose: "general", isPublic: false },
      ],
    },
  };
  const savedWebsites: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("userType", "hotel");
    localStorage.setItem("isLoggedIn", "true");
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
  });
  await page.route(/\/(?:api|auth)\//, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith("/auth/session")) {
      json = {
        accessToken: "hotel-access-token",
        csrfToken: "hotel-csrf-token",
        organizationId,
        organizationKind: "hotel_group",
        user: {
          id: "manager",
          email: "manager@example.com",
          name: "Hotel Manager",
          status: "active",
        },
      };
    } else if (path.endsWith("/hotel-setup/status")) {
      json = createAdaptiveHotelSetupStatusMock({
        entryProduct: "marketplace",
        organizationId,
        organizationDisplayName: "Alpenrose",
        propertyId,
        propertyDisplayName: "Hotel Alpenrose",
        taskOverrides: {
          shared_identity: { ownerProgress: "owner_complete", readiness: "complete" },
        },
      });
    } else if (path.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        expect(body.expectedProfileRevision).toBe(profile.profileRevision);
        profile.profile.contacts = body.patch.contacts;
        profile.profileRevision += 1;
        savedWebsites.push(
          profile.profile.contacts.find((contact) => contact.channelType === "website")!.value,
        );
      }
      json = profile;
    } else if (path.endsWith("/public-profile")) {
      json = {
        propertyId,
        profileRevision: 1,
        publicProfile: { locale: "en", shortDescription: null, longDescription: null, media: [] },
      };
    } else if (path.endsWith(`/marketplace/properties/${propertyId}/profile`)) {
      json = {
        propertyId,
        profileStatus: "verified",
        profileComplete: true,
        hostSummary: "Our independent city hotel welcomes creators from around the world.",
        collaborationGuidelines: null,
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
      };
    } else if (path.endsWith("/profile-status")) {
      json = {
        profile_complete: true,
        missing_fields: [],
        missing_offers: false,
        completion_steps: [],
      };
    } else if (path.endsWith("/offers")) {
      json = { offers: [] };
    }
    await route.fulfill({ status: 200, headers: corsHeaders(route), json });
  });
  await page.goto("/profile");
  await page.getByTitle("Edit Profile").click();
  const website = page.getByRole("textbox", { name: "Website", exact: true });
  for (const invalid of ["name", "https://", "name .com", "https://name.com/<invalid>"]) {
    await website.fill(invalid);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(
      page.getByText("Enter a valid website, such as name.com or https://name.com"),
    ).toBeVisible();
    await page.getByRole("button", { name: "OK", exact: true }).click();
    expect(savedWebsites).toEqual([]);
  }
  for (const [input, expected] of [
    ["name.com", "https://name.com"],
    ["www.name.com", "https://www.name.com"],
    ["http://name.com", "http://name.com"],
    ["https://name.com", "https://name.com"],
  ]) {
    await website.fill(input);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(website).toBeDisabled();
    expect(savedWebsites.at(-1)).toBe(expected);
    await page.reload();
    await expect(website).toHaveValue(expected);
    await page.getByTitle("Edit Profile").click();
  }
  expect(savedWebsites).toHaveLength(4);
});
