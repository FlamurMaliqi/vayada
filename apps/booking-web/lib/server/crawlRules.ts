const PRIVATE_CRAWL_PATHS = [
  "/addons",
  "/book",
  "/booking",
  "/booking-status",
  "/checkout",
  "/confirmation",
  "/my-booking",
  "/payment",
] as const;

export function publicAllowRules(locales: readonly string[]): string[] {
  const localeRules = locales.flatMap((locale) => [`/${locale}`, `/${locale}/rooms`]);
  return ["/", "/rooms", ...localeRules];
}

export function privateDisallowRules(locales: readonly string[]): string[] {
  return PRIVATE_CRAWL_PATHS.flatMap((path) => [
    path,
    `${path}/`,
    ...locales.flatMap((locale) => [`/${locale}${path}`, `/${locale}${path}/`]),
  ]);
}
