type PreviewLocation = Pick<Location, "protocol" | "hostname" | "port">;

export function buildBookingPreviewUrl(input: {
  slug: string;
  template?: string;
  location?: PreviewLocation;
}): string | null {
  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) return null;

  const template = input.template?.trim();
  if (template?.includes("{slug}")) return template.replaceAll("{slug}", slug);

  const location = input.location;
  if (location?.hostname === "localhost") {
    return `${location.protocol === "https:" ? "https:" : "http:"}//${slug}.localhost:3002`;
  }
  if (location?.hostname.endsWith(".localhost")) {
    const protocol = location.protocol === "http:" ? "http:" : "https:";
    const port = location.port ? `:${location.port}` : "";
    return `${protocol}//${slug}.booking.localhost${port}`;
  }

  return `https://${slug}.booking.vayada.com`;
}
