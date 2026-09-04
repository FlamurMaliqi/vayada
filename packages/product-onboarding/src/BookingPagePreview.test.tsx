import { createRef } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { BookingPagePreview } from "./BookingPagePreview";
import BrandMediaStep from "./BrandMediaStep";
import { BOOKING_PAGE_COLOR_PRESETS, BOOKING_PAGE_FONT_PAIRINGS } from "./bookingPageBranding";

describe("BookingPagePreview", () => {
  it("renders the shared Design Studio preview with live brand and localization values", () => {
    const renderer = create(
      <BookingPagePreview
        currency="CHF"
        defaultLanguage="de"
        font={BOOKING_PAGE_FONT_PAIRINGS[1]}
        heroHeading="Hotel One"
        heroImage=""
        heroSubtext="A quiet stay in the mountains."
        primaryColor="#2D6A4F"
        propertyName="Hotel One"
      />,
    );
    const text = renderer.root
      .findAll((node) => typeof node.children[0] === "string")
      .flatMap((node) => node.children)
      .join(" ");

    expect(text).toContain("Hotel One");
    expect(text).toContain("A quiet stay in the mountains.");
    expect(text).toContain("DE");
    expect(text).toContain("CHF");
    expect(text).toContain("Available Accommodations");
  });

  it("reflects hidden header controls immediately", () => {
    const renderer = create(
      <BookingPagePreview
        currency="CHF"
        defaultLanguage="de"
        font={BOOKING_PAGE_FONT_PAIRINGS[1]}
        heroHeading="Hotel One"
        heroImage=""
        heroSubtext="A quiet stay in the mountains."
        primaryColor="#2D6A4F"
        propertyName="Hotel One"
        showContactButton={false}
        showLanguageSelector={false}
        showCurrencySelector
        showReferAGuestButton
      />,
    );
    const text = renderer.root
      .findAll((node) => typeof node.children[0] === "string")
      .flatMap((node) => node.children)
      .join(" ");
    const headerSelectors = renderer.root.findAll(
      (node) =>
        typeof node.props.className === "string" &&
        node.props.className.includes("border-white/60") &&
        (node.children.includes("DE") || node.children.includes("CHF")),
    );
    const refer = renderer.root.findByProps({ "data-testid": "booking-preview-refer" });

    expect(text).not.toContain("Contact");
    expect(headerSelectors).toHaveLength(1);
    expect(headerSelectors[0]?.children).toContain("CHF");
    expect(text).toContain("Refer a Guest");
    expect(refer.props.className).not.toContain("hidden");
  });

  it("auto-hides header selectors when only one option is configured", () => {
    const renderer = create(
      <BookingPagePreview
        currency="CHF"
        defaultLanguage="de"
        font={BOOKING_PAGE_FONT_PAIRINGS[1]}
        heroHeading="Hotel One"
        heroImage=""
        heroSubtext="A quiet stay in the mountains."
        primaryColor="#2D6A4F"
        propertyName="Hotel One"
        supportedCurrencies={["CHF"]}
        supportedLanguages={["de"]}
      />,
    );
    const headerSelectors = renderer.root.findAll(
      (node) =>
        typeof node.props.className === "string" &&
        node.props.className.includes("border-white/60") &&
        (node.children.includes("DE") || node.children.includes("CHF")),
    );

    expect(headerSelectors).toHaveLength(0);
  });
});

describe("BrandMediaStep", () => {
  it("uses the compact Design Studio controls without retired publication fields", () => {
    const reset = vi.fn();
    const renderer = create(
      <BrandMediaStep
        canProceed
        colorPresets={BOOKING_PAGE_COLOR_PRESETS}
        currency="EUR"
        defaultLanguage="en"
        error=""
        fileInputRef={createRef<HTMLInputElement>()}
        fontPairings={BOOKING_PAGE_FONT_PAIRINGS}
        handleImageUpload={vi.fn()}
        heroHeading="Hotel One"
        heroImage=""
        imageRecommendation="1920x1080 recommended"
        onBack={null}
        onContinue={vi.fn()}
        onResetSubtext={reset}
        primaryColor="#0077B6"
        propertyDescription="Book direct for a memorable stay."
        propertyName="Hotel One"
        selectedFont="modern-minimalist"
        setHeroHeading={vi.fn()}
        setPrimaryColor={vi.fn()}
        setPropertyDescription={vi.fn()}
        setSelectedFont={vi.fn()}
        subtextMaxLength={200}
        subtextPlaceholder="A short tagline about your property."
        continueLabel="Publish booking page"
        continuingLabel="Publishing..."
        submitting={false}
        bookingUrl="Your booking URL"
        onImageFile={vi.fn()}
        uploading={false}
      />,
    );
    const text = renderer.root
      .findAll((node) => typeof node.children[0] === "string")
      .flatMap((node) => node.children)
      .join(" ");
    const subtext = renderer.root.findByProps({ "aria-label": "Hero subtext" });
    const resetButton = renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Reset to Default"));

    expect(text).toContain("Drop image or click to upload");
    expect(text).toContain("High-end Serif");
    expect(text).not.toContain("Public hotel description");
    expect(text).not.toContain("Booking page introduction");
    expect(text).not.toContain("Show the hotel city and country publicly");
    expect(subtext.props.maxLength).toBe(200);
    resetButton?.props.onClick();
    expect(reset).toHaveBeenCalledOnce();
  });
});
