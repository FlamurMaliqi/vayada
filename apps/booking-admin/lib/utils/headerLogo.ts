export const HEADER_LOGO_MAX_BYTES = 500 * 1024;
export const HEADER_LOGO_MAX_WIDTH = 300;
export const HEADER_LOGO_MAX_HEIGHT = 80;

const HEADER_LOGO_TYPES = new Set(["image/jpeg", "image/png", "image/svg+xml"]);

export function headerLogoUploadError(file: File): string | null {
  const supportedType = HEADER_LOGO_TYPES.has(file.type.toLowerCase());
  const supportedExtension = file.type === "" && /\.(jpe?g|png|svg)$/i.test(file.name);
  if (!supportedType && !supportedExtension) return "Choose a PNG, SVG, or JPEG logo.";
  if (file.size === 0) return "Choose a logo that isn’t empty.";
  if (file.size > HEADER_LOGO_MAX_BYTES) return "Choose a logo smaller than 500 KB.";
  return null;
}

export async function headerLogoDimensionsError(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image.naturalWidth > HEADER_LOGO_MAX_WIDTH ||
      image.naturalHeight > HEADER_LOGO_MAX_HEIGHT
      ? `Choose a logo no larger than ${HEADER_LOGO_MAX_WIDTH} × ${HEADER_LOGO_MAX_HEIGHT}px.`
      : null;
  } catch {
    return "Choose a valid PNG, SVG, or JPEG logo.";
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function headerLogoFileFromUrl(value: string): Promise<File> {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid image URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Enter a public HTTP or HTTPS image URL.");
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error("The logo URL could not be downloaded.");
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > HEADER_LOGO_MAX_BYTES) throw new Error("Choose a logo smaller than 500 KB.");
  const blob = await response.blob();
  const type = blob.type.toLowerCase();
  const filename = url.pathname.split("/").pop() || "logo";
  const file = new File([blob], filename, {
    type: HEADER_LOGO_TYPES.has(type) ? type : "",
  });
  const error = headerLogoUploadError(file);
  if (error) throw new Error(error);
  return file;
}
