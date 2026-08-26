import { COUNTRY_OPTIONS, type CountryOption } from "@vayada/locale-constants";

/** ISO user-assigned codes kept inside the existing CHAR(2) storage contract. */
const SPECIAL_NATIONALITIES: readonly CountryOption[] = [
  { code: "XS", name: "Stateless", flag: "🏳️" },
  { code: "XX", name: "Unknown", flag: "❔" },
];

export const NATIONALITY_OPTIONS: readonly CountryOption[] = [
  ...COUNTRY_OPTIONS,
  ...SPECIAL_NATIONALITIES,
].sort((left, right) => left.name.localeCompare(right.name));

const BY_CODE = new Map(NATIONALITY_OPTIONS.map((option) => [option.code, option]));
const BY_NAME = new Map(
  NATIONALITY_OPTIONS.map((option) => [normalizedName(option.name), option.code]),
);
const ALIASES = new Map([
  ["america", "US"],
  ["dutch", "NL"],
  ["great britain", "GB"],
  ["holland", "NL"],
  ["the netherlands", "NL"],
  ["uk", "GB"],
  ["unknown nationality", "XX"],
  ["us", "US"],
  ["usa", "US"],
]);

export function normalizeNationalityCode(value: string | null | undefined): string | null {
  const input = value?.trim();
  if (!input) return null;
  const code = input.toUpperCase();
  if (BY_CODE.has(code)) return code;
  const name = normalizedName(input);
  return ALIASES.get(name) ?? BY_NAME.get(name) ?? null;
}

export function nationalityOption(value: string | null | undefined): CountryOption | null {
  const code = normalizeNationalityCode(value);
  return code ? (BY_CODE.get(code) ?? null) : null;
}

export function nationalityLabel(value: string | null | undefined): string | null {
  return nationalityOption(value)?.name ?? null;
}

export function nationalityInputLabel(value: string | null | undefined): string {
  return nationalityLabel(value) ?? value?.trim() ?? "";
}

export function nationalityDisplayLabel(value: string | null | undefined): string | null {
  const input = value?.trim();
  if (!input) return null;
  return nationalityLabel(input) ?? `${input} · Needs review`;
}

function normalizedName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
