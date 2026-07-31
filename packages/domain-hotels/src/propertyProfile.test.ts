import { describe, expect, it } from "vitest";

import {
  parseCreatePropertyProfileRequest,
  parsePropertyProfileResponse,
  parseUpdatePropertyProfileRequest,
  type PropertyProfileResponse,
} from "./propertyProfile.js";

const response: PropertyProfileResponse = {
  propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  profileRevision: 3,
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
      localityPublic: false,
      geoPublic: false,
      mapDisplayMode: "hidden",
    },
    contacts: [
      {
        channelType: "email",
        value: "hello@alpenrose.example",
        purpose: "guest",
        isPublic: false,
      },
    ],
  },
};

describe("canonical property profile wire contract", () => {
  it("accepts stored incomplete profiles on reads while keeping create writes strict", () => {
    const incomplete = {
      propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      profileRevision: 1,
      profile: {
        displayName: "",
        propertyType: "",
        location: {
          streetAddress: "",
          postalCode: "",
          city: "",
          countryCode: "",
          timezone: "",
          latitude: null,
          longitude: null,
          localityPublic: false,
          geoPublic: false,
          mapDisplayMode: "hidden",
        },
        contacts: [],
      },
    };

    expect(parsePropertyProfileResponse(incomplete)).toEqual(incomplete);
    expect(parseCreatePropertyProfileRequest(incomplete.profile)).toBeNull();
  });

  it("parses only the exact nested create profile", () => {
    expect(parseCreatePropertyProfileRequest(response.profile)).toEqual(response.profile);
    expect(
      parseCreatePropertyProfileRequest({
        ...response.profile,
        website: "https://legacy.example",
      }),
    ).toBeNull();
  });

  it("parses the nested response including revision and contact metadata", () => {
    expect(parsePropertyProfileResponse(response)).toEqual(response);
    expect(
      parsePropertyProfileResponse({
        ...response,
        profile: {
          ...response.profile,
          contacts: [{ channelType: "email", value: "owner@example.com", isPublic: false }],
        },
      }),
    ).toBeNull();
  });

  it("accepts sparse update patches and rejects unknown top-level fields", () => {
    expect(
      parseUpdatePropertyProfileRequest({
        expectedProfileRevision: 3,
        patch: { location: { localityPublic: true } },
      }),
    ).toEqual({
      expectedProfileRevision: 3,
      patch: { location: { localityPublic: true } },
    });
    expect(
      parseUpdatePropertyProfileRequest({
        expectedProfileRevision: 3,
        patch: { displayName: "Alpenrose" },
        unexpected: true,
      }),
    ).toBeNull();
  });

  it("rejects the removed addressPublic compatibility field", () => {
    expect(
      parseCreatePropertyProfileRequest({
        ...response.profile,
        location: {
          ...response.profile.location,
          localityPublic: undefined,
          addressPublic: true,
        },
      }),
    ).toBeNull();
    expect(
      parseUpdatePropertyProfileRequest({
        expectedProfileRevision: 3,
        patch: { location: { addressPublic: true } },
      }),
    ).toBeNull();
  });
});
