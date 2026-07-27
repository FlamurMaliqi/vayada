import { describe, expect, it } from "vitest";

import {
  clearSetupReturnContext,
  readSetupReturnContext,
  saveSetupReturnContext,
} from "./setupReturnContext";

describe("setup return context", () => {
  it("round-trips allowlisted product context for the selected property", () => {
    const storage = memoryStorage();

    saveSetupReturnContext(
      {
        propertyId: " property-1 ",
        entryProduct: "pms",
        returnProduct: "booking",
        returnTo: "/settings?section=booking",
      },
      storage,
    );

    expect(readSetupReturnContext("property-1", storage)).toEqual({
      propertyId: "property-1",
      entryProduct: "pms",
      returnProduct: "booking",
      returnTo: "/settings?section=booking",
    });
    clearSetupReturnContext(storage);
    expect(readSetupReturnContext("property-1", storage)).toBeNull();
  });

  it("rejects another property, unsafe paths, invalid products, and corrupt data", () => {
    const storage = memoryStorage();
    saveSetupReturnContext(
      {
        propertyId: "property-1",
        entryProduct: "pms",
        returnProduct: "booking",
        returnTo: "https://attacker.example/settings",
      },
      storage,
    );
    expect(readSetupReturnContext("property-1", storage)).toBeNull();

    storage.setItem(
      "vayada.hotelSetup.returnContext",
      JSON.stringify({
        propertyId: "property-1",
        entryProduct: "unknown",
        returnProduct: "booking",
        returnTo: "/settings",
      }),
    );
    expect(readSetupReturnContext("property-1", storage)).toBeNull();

    storage.setItem(
      "vayada.hotelSetup.returnContext",
      JSON.stringify({
        propertyId: "property-1",
        entryProduct: "pms",
        returnProduct: "booking",
        returnTo: "/settings",
      }),
    );
    expect(readSetupReturnContext("property-2", storage)).toBeNull();

    storage.setItem("vayada.hotelSetup.returnContext", "{");
    expect(readSetupReturnContext("property-1", storage)).toBeNull();
  });
});

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
