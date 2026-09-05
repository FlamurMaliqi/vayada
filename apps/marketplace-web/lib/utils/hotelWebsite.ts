/** Accept a domain or HTTP(S) URL without changing an existing URL's spelling. */
export function normalizeHotelWebsite(input: string): string {
  const value = input.trim();
  if (!value) return "";

  const website = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const authority = website.match(/^https?:\/\/([^/?#]+)/i)?.[1];
    const url = new URL(website);
    if (
      !authority ||
      /[%@]/.test(authority) ||
      /[\s\u0000-\u001f\u007f<>"\\^`{|}]/.test(value) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
        url.hostname,
      )
    ) {
      throw new Error("Invalid website");
    }
    return website;
  } catch {
    throw new Error("Enter a valid website, such as name.com or https://name.com");
  }
}
