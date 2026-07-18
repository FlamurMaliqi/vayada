import { describe, expect, it } from "vitest";

import { addressFromGooglePlace } from "./GooglePlacesAddressField";

describe("addressFromGooglePlace", () => {
  it("maps a Google place to the shared hotel location fields", () => {
    expect(
      addressFromGooglePlace({
        addressComponents: [
          component("Marienplatz", "Marienplatz", "route"),
          component("1", "1", "street_number"),
          component("80331", "80331", "postal_code"),
          component("Munich", "Munich", "locality"),
          component("Bavaria", "BY", "administrative_area_level_1"),
          component("Germany", "DE", "country"),
        ],
        location: { lat: () => 48.1373932, lng: () => 11.5754485 },
      }),
    ).toEqual({
      streetAddress: "Marienplatz 1",
      postalCode: "80331",
      city: "Munich",
      region: "Bavaria",
      countryCode: "DE",
      latitude: 48.1373932,
      longitude: 11.5754485,
    });
  });

  it("uses postal town when Google does not return a locality", () => {
    expect(
      addressFromGooglePlace({
        addressComponents: [component("London", "London", "postal_town")],
      }).city,
    ).toBe("London");
  });

  it("uses Google's localized postal address line", () => {
    expect(
      addressFromGooglePlace({
        addressComponents: [
          component("Amphitheatre Parkway", "Amphitheatre Pkwy", "route"),
          component("1600", "1600", "street_number"),
        ],
        postalAddress: {
          addressLines: ["1600 Amphitheatre Parkway"],
          administrativeArea: "California",
          locality: "Mountain View",
          postalCode: "94043",
          regionCode: "US",
        },
      }),
    ).toMatchObject({
      streetAddress: "1600 Amphitheatre Parkway",
      postalCode: "94043",
      city: "Mountain View",
      region: "California",
      countryCode: "US",
    });
  });

  it("keeps a street-only suggestion incomplete and drops road-level coordinates", () => {
    expect(
      addressFromGooglePlace(
        {
          addressComponents: [
            component("Marienplatz", "Marienplatz", "route"),
            component("80331", "80331", "postal_code"),
            component("Munich", "Munich", "locality"),
            component("Germany", "DE", "country"),
          ],
          location: { lat: () => 48.1373932, lng: () => 11.5754485 },
        },
        false,
      ),
    ).toMatchObject({
      streetAddress: "Marienplatz",
      postalCode: "80331",
      city: "Munich",
      countryCode: "DE",
      latitude: null,
      longitude: null,
    });
  });
});

function component(longText: string, shortText: string, type: string) {
  return { longText, shortText, types: [type] };
}
