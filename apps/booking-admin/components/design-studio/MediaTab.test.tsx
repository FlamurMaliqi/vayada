import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/lib/i18n";
import MediaTab, { type PropertyGalleryImage } from "./MediaTab";

function renderMediaTab(galleryImages: PropertyGalleryImage[]) {
  return renderToStaticMarkup(
    <LanguageProvider>
      <MediaTab
        heroImage=""
        setHeroImage={vi.fn()}
        heroHeading=""
        setHeroHeading={vi.fn()}
        heroSubtext=""
        setHeroSubtext={vi.fn()}
        fileInputRef={createRef<HTMLInputElement>()}
        handleImageUpload={vi.fn()}
        removeHeroImage={vi.fn()}
        headerLogo=""
        headerLogoUrl=""
        logoInputRef={createRef<HTMLInputElement>()}
        handleLogoUpload={vi.fn()}
        addHeaderLogoUrl={vi.fn()}
        setHeaderLogoUrl={vi.fn()}
        removeHeaderLogo={vi.fn()}
        uploadingLogo={false}
        showContactButton
        setShowContactButton={vi.fn()}
        showReferAGuestButton={false}
        setShowReferAGuestButton={vi.fn()}
        referAGuestModuleEnabled={false}
        showLanguageSelector
        setShowLanguageSelector={vi.fn()}
        showCurrencySelector
        setShowCurrencySelector={vi.fn()}
        resetContent={vi.fn()}
        galleryImages={galleryImages}
        galleryAtCapacity={galleryImages.length >= 10}
        galleryBusy={false}
        addGalleryImages={vi.fn()}
        removeGalleryImage={vi.fn()}
        reorderGalleryImage={vi.fn()}
      />
    </LanguageProvider>,
  );
}

describe("MediaTab property gallery", () => {
  it("renders the empty uploader with the ten-photo guidance", () => {
    const markup = renderMediaTab([]);

    expect(markup).toContain("Property Gallery");
    expect(markup).toContain("Showcase your property with up to 10 photos");
    expect(markup).toContain("0/10");
    expect(markup).toContain("Click or drag photos here");
    expect(markup).toContain("Landscape photos work best");
  });

  it("marks the first ordered photo as the cover and exposes add and remove controls", () => {
    const markup = renderMediaTab([
      {
        mediaObjectId: "11111111-1111-4111-8111-111111111111",
        url: "https://cdn.vayada.com/property-1.webp",
        altText: null,
      },
      {
        mediaObjectId: "22222222-2222-4222-8222-222222222222",
        url: "https://cdn.vayada.com/property-2.webp",
        altText: null,
      },
    ]);

    expect(markup).toContain("2/10");
    expect(markup.match(/COVER/g)).toHaveLength(1);
    expect(markup).toContain("Remove property photo 1");
    expect(markup).toContain("Remove property photo 2");
    expect(markup).toContain("Move property photo 1 earlier");
    expect(markup).toContain("Move property photo 1 later");
    expect(markup).toContain("Move property photo 2 earlier");
    expect(markup).toContain("Move property photo 2 later");
    expect(markup).toContain(">Add<");
  });
});
