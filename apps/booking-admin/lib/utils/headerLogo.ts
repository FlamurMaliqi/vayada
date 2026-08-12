export const HEADER_LOGO_MAX_BYTES = 500 * 1024;

const HEADER_LOGO_TYPES = new Set(["image/jpeg", "image/png", "image/svg+xml"]);

export function headerLogoUploadError(file: File): string | null {
  const supportedType = HEADER_LOGO_TYPES.has(file.type.toLowerCase());
  const supportedExtension = file.type === "" && /\.(jpe?g|png|svg)$/i.test(file.name);
  if (!supportedType && !supportedExtension) return "Choose a PNG, SVG, or JPEG logo.";
  if (file.size === 0) return "Choose a logo that isn’t empty.";
  if (file.size > HEADER_LOGO_MAX_BYTES) return "Choose a logo smaller than 500 KB.";
  return null;
}
