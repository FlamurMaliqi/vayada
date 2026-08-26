import { normalizeNationalityCode } from "@vayada/locale-constants";

export type ImportedNationalityMap = {
  sourceValues: string[];
  countryCodes: Array<string | null>;
  rawValues: Array<string | null>;
  reviewRequired: boolean[];
};

export function importedNationalityMap(
  values: readonly (string | null | undefined)[],
): ImportedNationalityMap {
  const sourceValues = [...new Set(values.filter((value): value is string => value != null))];
  const rows = sourceValues.map((sourceValue) => {
    const rawValue = sourceValue.trim();
    const countryCode = normalizeNationalityCode(rawValue);
    return {
      countryCode,
      rawValue: rawValue && !countryCode ? rawValue : null,
      reviewRequired: Boolean(rawValue && !countryCode),
    };
  });
  return {
    sourceValues,
    countryCodes: rows.map((row) => row.countryCode),
    rawValues: rows.map((row) => row.rawValue),
    reviewRequired: rows.map((row) => row.reviewRequired),
  };
}
