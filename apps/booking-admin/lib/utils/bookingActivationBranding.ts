type BookingActivationBrandingInput = {
  heroImage: string;
  heroHeading: string;
  heroSubtext: string;
  primaryColor: string;
  selectedFont: string;
  supportedFontPairings: readonly string[];
  uploading: boolean;
};

export function isBookingActivationBrandingReady(input: BookingActivationBrandingInput): boolean {
  return Boolean(
    input.heroImage.trim() &&
    input.heroHeading.trim() &&
    input.heroSubtext.trim() &&
    !input.uploading &&
    /^#[0-9A-Fa-f]{6}$/.test(input.primaryColor) &&
    input.supportedFontPairings.includes(input.selectedFont),
  );
}
