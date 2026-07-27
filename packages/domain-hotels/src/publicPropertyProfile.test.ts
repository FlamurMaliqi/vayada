import { describe, expect, it } from "vitest";

import {
  parsePublicPropertyProfileResponse,
  parseUpdatePublicPropertyProfileRequest,
  type PublicPropertyProfileResponse,
} from "./publicPropertyProfile.js";

const response: PublicPropertyProfileResponse = {
  propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  profileRevision: 4,
  publicProfile: {
    locale: "en",
    shortDescription: "A hotel in Munich.",
    longDescription: null,
    media: [
      {
        mediaObjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        mediaType: "hero_image",
        url: "https://cdn.example/hotel.webp",
        altText: "Hotel exterior",
        sortOrder: 0,
      },
    ],
  },
};

describe("canonical public property profile wire contract", () => {
  it("parses only the exact nested response", () => {
    expect(parsePublicPropertyProfileResponse(response)).toEqual(response);
    expect(
      parsePublicPropertyProfileResponse({
        ...response,
        publicProfile: { ...response.publicProfile, legacyImageUrl: "https://legacy.example" },
      }),
    ).toBeNull();
    expect(
      parsePublicPropertyProfileResponse({
        ...response,
        publicProfile: {
          ...response.publicProfile,
          media: [response.publicProfile.media[0], response.publicProfile.media[0]],
        },
      }),
    ).toBeNull();
  });

  it("parses sparse patches and rejects duplicate media references", () => {
    expect(
      parseUpdatePublicPropertyProfileRequest({
        expectedProfileRevision: 4,
        patch: { shortDescription: null },
      }),
    ).toEqual({
      expectedProfileRevision: 4,
      patch: { shortDescription: null },
    });
    const media = {
      mediaObjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      altText: null,
      sortOrder: 0,
    };
    expect(
      parseUpdatePublicPropertyProfileRequest({
        expectedProfileRevision: 4,
        patch: { media: [media, media] },
      }),
    ).toBeNull();
    expect(
      parseUpdatePublicPropertyProfileRequest({
        expectedProfileRevision: 4,
        patch: { media: [{ ...media, sourceUrl: "https://legacy.example" }] },
      }),
    ).toBeNull();
    expect(
      parseUpdatePublicPropertyProfileRequest({
        expectedProfileRevision: 4,
        patch: { media: [{ ...media, sortOrder: 2_147_483_648 }] },
      }),
    ).toBeNull();
  });
});
