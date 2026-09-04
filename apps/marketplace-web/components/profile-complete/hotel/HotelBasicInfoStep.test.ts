import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { HotelBasicInfoStep } from "./HotelBasicInfoStep";

const form = {
  about: "A creator-friendly hotel introduction with enough detail to complete Marketplace setup.",
  localityPublic: false,
};

describe("HotelBasicInfoStep cover recovery", () => {
  it("renders a required photo picker when an existing offer has no reusable cover", () => {
    const html = renderToStaticMarkup(
      createElement(HotelBasicInfoStep, {
        form,
        onFormChange: vi.fn(),
        error: "",
        showCoverPhotoPicker: true,
        coverPhotoRequired: true,
        coverPhotoInputRef: createRef<HTMLInputElement>(),
        onCoverPhotoChange: vi.fn(),
      }),
    );

    expect(html).toContain("Public hotel cover");
    expect(html).toContain("Choose a hotel cover photo");
    expect(html).toContain('type="file"');
    expect(html).toContain('aria-required="true"');
  });

  it("keeps a replacement picker available while reusing an existing offer photo", () => {
    const html = renderToStaticMarkup(
      createElement(HotelBasicInfoStep, {
        form,
        onFormChange: vi.fn(),
        error: "",
        showCoverPhotoPicker: true,
        coverPhotoPreview: "https://cdn.example/existing-offer.jpg",
        coverPhotoInputRef: createRef<HTMLInputElement>(),
        onCoverPhotoChange: vi.fn(),
      }),
    );

    expect(html).toContain("Existing offer photo");
    expect(html).toContain("Choose a different photo");
    expect(html).toContain('aria-label="Hotel cover photo file"');
  });

  it("keeps the recovery controls out of the new-offer introduction step", () => {
    const html = renderToStaticMarkup(
      createElement(HotelBasicInfoStep, {
        form,
        onFormChange: vi.fn(),
        error: "",
      }),
    );

    expect(html).not.toContain("Public hotel cover");
    expect(html).not.toContain('type="file"');
  });

  it("renders unchecked explicit locality consent with its privacy boundary", () => {
    const html = renderToStaticMarkup(
      createElement(HotelBasicInfoStep, {
        form,
        onFormChange: vi.fn(),
        error: "",
      }),
    );

    expect(html).toContain("Show city and country on public vayada surfaces");
    expect(html).toContain("Creator Marketplace and direct-booking experiences");
    expect(html).toContain("exact street address and coordinates stay private");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("required");
    expect(html).not.toContain("checked");
  });

  it("does not request shared locality consent in the creator-profile task", () => {
    const html = renderToStaticMarkup(
      createElement(HotelBasicInfoStep, {
        form,
        onFormChange: vi.fn(),
        error: "",
        showLocalityConsent: false,
      }),
    );

    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("public vayada surfaces");
  });
});
