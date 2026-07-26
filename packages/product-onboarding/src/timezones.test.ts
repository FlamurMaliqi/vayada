import { describe, expect, it, vi } from "vitest";

import {
  availableTimezones,
  defaultTimezoneForCountry,
  filterTimezones,
  timezoneForCoordinates,
} from "./timezones";

describe("property time-zone detection", () => {
  it("uses the property country instead of the browser time zone", () => {
    expect(defaultTimezoneForCountry("DE")).toBe("Europe/Berlin");
    expect(defaultTimezoneForCountry("AT")).toBe("Europe/Vienna");
    expect(defaultTimezoneForCountry("not-a-country")).toBe("");
  });

  it("includes every country default in the picker", () => {
    const options = availableTimezones();
    for (const country of ["DE", "AT", "IN", "NP", "AR", "US", "ID"]) {
      expect(options).toContain(defaultTimezoneForCountry(country));
    }
  });

  it("keeps country defaults when the browser lacks supportedValuesOf", () => {
    const supportedValues = vi.spyOn(Intl, "supportedValuesOf").mockImplementation(() => {
      throw new TypeError("unsupported");
    });
    expect(availableTimezones()).toContain("Asia/Kolkata");
    supportedValues.mockRestore();
  });

  it("uses coordinates to distinguish Indonesian time zones", () => {
    expect(timezoneForCoordinates(-8.4095, 115.1889)).toBe("Asia/Makassar");
    expect(timezoneForCoordinates(-6.2088, 106.8456)).toBe("Asia/Jakarta");
  });

  it("filters the picker by city name", () => {
    expect(filterTimezones(["Europe/Berlin", "Europe/Paris"], "berlin")).toEqual(["Europe/Berlin"]);
  });
});
