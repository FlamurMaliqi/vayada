import { expect, it } from "vitest";
import { formatTimezoneLabel } from "./timezoneLabel";

it("formats display labels without changing IANA separators or offsets", () => {
  expect(formatTimezoneLabel("America/New_York")).toBe("America/New York");
  expect(formatTimezoneLabel("America/Sao_Paulo")).toBe("America/Sao Paulo");
  expect(formatTimezoneLabel("America/Argentina/Buenos_Aires")).toBe(
    "America/Argentina/Buenos Aires",
  );
  expect(formatTimezoneLabel("America/North_Dakota/New_Salem")).toBe(
    "America/North Dakota/New Salem",
  );
  expect(formatTimezoneLabel("Europe/Berlin")).toBe("Europe/Berlin");
  expect(formatTimezoneLabel("Etc/GMT+5")).toBe("Etc/GMT+5");
});
