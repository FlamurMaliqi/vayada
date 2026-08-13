import { z } from "zod";

import {
  PUBLIC_BOOKABILITY_CONTACT_CHANNEL_TYPES,
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS,
  PUBLIC_BOOKABILITY_FRESHNESS_STATUSES,
  PUBLIC_BOOKABILITY_REASON_CODES,
  PUBLIC_BOOKABILITY_STATUSES,
  PUBLIC_BOOKABILITY_VISIBILITY,
  assertPublicBookabilityPublicSafe,
  type PublicBookabilityProfileProjection,
} from "./index.js";

const SOURCE_REASON_CODES = ["source_unavailable", "source_stale", "not_configured"] as const;
const nonEmpty = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value && !value.includes("\0"));
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
  .refine(validInstant);
const httpsUrl = nonEmpty.refine((value) => validHttpsUrl(value));
const originUrl = nonEmpty.refine((value) => validHttpsUrl(value, true));
const locale = nonEmpty.refine((value) => validLocale(value));
const currency = z.string().regex(/^[A-Z]{3}$/);
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const optionalText = nonEmpty.nullable().optional();

const locationSchema = z.strictObject({
  country: z.string().regex(/^[A-Z]{2}$/),
  city: nonEmpty,
  region: optionalText,
  latitude: z.number().finite().min(-90).max(90).nullable().optional(),
  longitude: z.number().finite().min(-180).max(180).nullable().optional(),
});
const imageSchema = z.strictObject({ url: httpsUrl, alt: optionalText });
const contactSchema = z
  .strictObject({
    type: z.enum(PUBLIC_BOOKABILITY_CONTACT_CHANNEL_TYPES),
    value: nonEmpty,
  })
  .superRefine((contact, context) => {
    if (
      (contact.type === "website" ||
        contact.type === "instagram" ||
        contact.type === "facebook" ||
        contact.type === "x") &&
      !validHttpsUrl(contact.value)
    )
      issue(context, ["value"]);
    if (contact.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.value))
      issue(context, ["value"]);
  });
const policiesSchema = z.strictObject({
  checkInFrom: localTime.nullable().optional(),
  checkOutUntil: localTime.nullable().optional(),
  cancellationSummary: optionalText,
  termsUrl: httpsUrl.nullable().optional(),
});
const capabilitiesSchema = z.strictObject({
  instantBook: z.boolean(),
  onlinePayment: z.boolean(),
  payAtProperty: z.boolean(),
  promoCodes: z.boolean(),
  referralCodes: z.boolean(),
  bookingDeepLinks: z.boolean(),
});
const quoteParametersSchema = z.strictObject({
  minRooms: z.number().int().min(1),
  maxRooms: z.number().int().min(1),
  minAdults: z.number().int().min(1),
  maxAdults: z.number().int().min(1),
  childrenSupported: z.boolean(),
  adultAgeThreshold: z.number().int().min(1).max(120),
  supportedCurrencies: uniqueArray(currency).min(1),
  supportedLocales: uniqueArray(locale).min(1),
});
const brandingSchema = z.strictObject({
  logoUrl: httpsUrl.nullable().optional(),
  heroImage: httpsUrl.nullable(),
  heroHeading: nonEmpty.nullable(),
  heroSubtext: nonEmpty.nullable(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullable(),
  fontPairing: nonEmpty.nullable(),
});
const trustSchema = z.strictObject({
  profileComplete: z.boolean(),
  profileVerified: z.boolean(),
  domainVerified: z.boolean(),
  bookabilityStatus: z.enum(PUBLIC_BOOKABILITY_STATUSES),
  reasonCodes: uniqueArray(z.enum(PUBLIC_BOOKABILITY_REASON_CODES)),
});
const sourceSchema = z
  .strictObject({
    owner: z.enum(PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS),
    lastUpdatedAt: instant.optional(),
    status: z.enum(PUBLIC_BOOKABILITY_FRESHNESS_STATUSES),
    reasonCode: z.enum(SOURCE_REASON_CODES).optional(),
  })
  .superRefine((source, context) => {
    const expected =
      source.status === "unavailable"
        ? "source_unavailable"
        : source.status === "stale"
          ? "source_stale"
          : source.status === "unknown"
            ? "not_configured"
            : undefined;
    if (source.reasonCode !== expected) issue(context, ["reasonCode"]);
    if ((source.status === "fresh" || source.status === "stale") && !source.lastUpdatedAt)
      issue(context, ["lastUpdatedAt"]);
  });
const freshnessSchema = z
  .strictObject({
    status: z.enum(PUBLIC_BOOKABILITY_FRESHNESS_STATUSES),
    generatedAt: instant,
    sources: uniqueArray(sourceSchema, ({ owner }) => owner),
  })
  .superRefine((freshness, context) => {
    if (
      !sameSet(
        freshness.sources.map(({ owner }) => owner),
        PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS,
      )
    )
      issue(context, ["sources"]);
    const rollup = ["unavailable", "stale", "unknown"].find((status) =>
      freshness.sources.some((source) => source.status === status),
    );
    if (freshness.status !== (rollup ?? "fresh")) issue(context, ["status"]);
  });
const hotelSchema = z.strictObject({
  propertyId: nonEmpty,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: nonEmpty,
  canonicalUrl: httpsUrl,
  bookingBaseUrl: originUrl,
  customDomainUrl: originUrl.nullable(),
  timezone: nonEmpty.refine((value) => validTimeZone(value)),
  defaultLocale: locale,
  supportedLocales: uniqueArray(locale).min(1),
  defaultCurrency: currency,
  supportedCurrencies: uniqueArray(currency).min(1),
  location: locationSchema,
  summary: optionalText,
  branding: brandingSchema.optional(),
  images: uniqueArray(imageSchema, ({ url }) => url),
  amenities: uniqueArray(nonEmpty),
  publicContacts: uniqueArray(contactSchema, ({ type, value }) => `${type}\0${value}`),
  policies: policiesSchema,
  capabilities: capabilitiesSchema,
  supportedQuoteParameters: quoteParametersSchema,
  trust: trustSchema,
});

const profileSchema: z.ZodType<PublicBookabilityProfileProjection> = z
  .strictObject({
    contractVersion: z.literal(PUBLIC_BOOKABILITY_CONTRACT_VERSION),
    generatedAt: instant,
    publicVisibility: z.literal(PUBLIC_BOOKABILITY_VISIBILITY),
    hotel: hotelSchema,
    freshness: freshnessSchema,
    dataSources: uniqueArray(z.enum(PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS)),
  })
  .superRefine((profile, context) => {
    const { hotel } = profile;
    if (profile.generatedAt !== profile.freshness.generatedAt) issue(context, ["freshness"]);
    if (!sameSet(profile.dataSources, PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS))
      issue(context, ["dataSources"]);
    if (!hotel.supportedLocales.includes(hotel.defaultLocale))
      issue(context, ["hotel", "defaultLocale"]);
    if (!hotel.supportedCurrencies.includes(hotel.defaultCurrency))
      issue(context, ["hotel", "defaultCurrency"]);
    if (!sameSet(hotel.supportedQuoteParameters.supportedLocales, hotel.supportedLocales))
      issue(context, ["hotel", "supportedQuoteParameters", "supportedLocales"]);
    if (!sameSet(hotel.supportedQuoteParameters.supportedCurrencies, hotel.supportedCurrencies))
      issue(context, ["hotel", "supportedQuoteParameters", "supportedCurrencies"]);
    if (
      hotel.supportedQuoteParameters.maxRooms < hotel.supportedQuoteParameters.minRooms ||
      hotel.supportedQuoteParameters.maxAdults < hotel.supportedQuoteParameters.minAdults
    )
      issue(context, ["hotel", "supportedQuoteParameters"]);
    const bookingOrigin = new URL(hotel.bookingBaseUrl).origin;
    if (
      new URL(hotel.canonicalUrl).origin !== bookingOrigin ||
      (hotel.customDomainUrl && new URL(hotel.customDomainUrl).origin !== bookingOrigin) ||
      hotel.trust.domainVerified !== Boolean(hotel.customDomainUrl)
    )
      issue(context, ["hotel", "customDomainUrl"]);
    if (
      hotel.trust.bookabilityStatus === "bookable" &&
      (!hotel.trust.profileComplete ||
        !hotel.trust.profileVerified ||
        hotel.trust.reasonCodes.length > 0 ||
        hotel.images.length === 0 ||
        (!hotel.capabilities.onlinePayment && !hotel.capabilities.payAtProperty) ||
        !hotel.capabilities.bookingDeepLinks)
    )
      issue(context, ["hotel", "trust"]);
    if (
      profile.freshness.sources.some(
        ({ lastUpdatedAt }) =>
          lastUpdatedAt && Date.parse(lastUpdatedAt) > Date.parse(profile.generatedAt),
      )
    )
      issue(context, ["freshness", "sources"]);
  });

/** Parses stored JSON and returns a deeply frozen, allowlisted reconstruction. */
export function parsePublicBookabilityProfileProjection(
  value: unknown,
): PublicBookabilityProfileProjection | null {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    assertPublicBookabilityPublicSafe(parsed.data);
    return deepFreeze(parsed.data);
  } catch {
    return null;
  }
}

function uniqueArray<T>(schema: z.ZodType<T>, key: (value: T) => unknown = (value) => value) {
  return z.array(schema).superRefine((values, context) => {
    if (new Set(values.map(key)).size !== values.length) issue(context, []);
  });
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function issue(context: z.RefinementCtx, path: PropertyKey[]): void {
  context.addIssue({ code: "custom", message: "Invalid public profile contract", path });
}

function validHttpsUrl(value: string, originOnly = false): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!originOnly || (url.pathname === "/" && !url.search))
    );
  } catch {
    return false;
  }
}

function validInstant(value: string): boolean {
  try {
    const canonical = value.replace(
      /(?:\.(\d{1,3}))?Z$/,
      (_match, fraction = "") => `.${fraction.padEnd(3, "0")}Z`,
    );
    return new Date(value).toISOString() === canonical;
  } catch {
    return false;
  }
}

function validLocale(value: string): boolean {
  try {
    new Intl.Locale(value);
    return true;
  } catch {
    return false;
  }
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
