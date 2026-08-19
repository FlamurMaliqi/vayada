import { describe, expect, it } from "vitest";
import {
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  POPULAR_CURRENCY_CODES,
} from "@vayada/locale-constants";

import { filterLocalizationOptions } from "./LocalizationMultiSelect";

describe("filterLocalizationOptions", () => {
  it("finds currencies from the full catalog by code and name", () => {
    const search = (query: string) =>
      filterLocalizationOptions(
        CURRENCY_OPTIONS,
        "HUF",
        query,
        (option) => `${option.name} · ${option.code}`,
      ).map((option) => option.code);

    expect(search("USD")).toEqual(["USD"]);
    expect(search("Dollar")).toContain("USD");
    expect(search("idr")).toEqual(["IDR"]);
    expect(search("LKR")).toEqual(["LKR"]);
    expect(search("HUF")).toEqual([]);
  });

  it("finds languages by code, English name, and native name", () => {
    const search = (query: string) =>
      filterLocalizationOptions(
        LANGUAGE_OPTIONS,
        "en",
        query,
        (option) => `${option.name} · ${option.nativeName}`,
      ).map((option) => option.code);

    expect(search("Dutch")).toEqual(["nl"]);
    expect(search("nederlands")).toEqual(["nl"]);
    expect(search("nl")).toEqual(["nl"]);
    expect(search("zh")).toEqual(["zh"]);
    expect(search("English")).toEqual([]);
  });

  it("keeps USD in the shared popular currency choices", () => {
    expect(POPULAR_CURRENCY_CODES).toContain("USD");
  });
});
