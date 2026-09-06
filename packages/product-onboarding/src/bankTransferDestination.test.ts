import { describe, expect, it, vi } from "vitest";
import { saveBankTransferDestination, type DirectTransferDetails } from "./bankTransferDestination";

const blank: DirectTransferDetails = {
  accountHolder: "",
  accountType: "iban",
  accountNumber: "",
  bankName: "",
  bicSwift: "",
  instructions: "",
};
const details = {
  ...blank,
  accountHolder: "Test Hotel",
  accountNumber: "DE89370400440532013000",
  bankName: "Test Bank",
};
const saved = {
  id: "destination",
  revision: 2,
  version: 5,
  enabled: true,
  deleted: false,
  maskedAccount: "•••• 3000",
};
function transport() {
  return {
    get: vi.fn(async <T>() => ({ destination: saved }) as T),
    put: vi.fn(async <T>(_path: string, _body: unknown) => ({ destination: saved }) as T),
  };
}

describe("independent direct-transfer destination", () => {
  it("retries a lost response with the original command and reuses success after a policy failure", async () => {
    const client = transport();
    const attempt = {};
    const input = { propertyId: "property", enabled: true, details, saved: null, attempt };
    client.put.mockRejectedValueOnce(new Error("Response lost after commit"));
    await expect(saveBankTransferDestination(client, input)).rejects.toThrow("Response lost");
    await saveBankTransferDestination(client, input);
    expect(client.put.mock.calls[1]).toEqual(client.put.mock.calls[0]);
    await saveBankTransferDestination(client, { ...input, saved });
    expect(client.put).toHaveBeenCalledTimes(2);
  });
  it("does not require bank details for provider-only onboarding", async () => {
    const client = transport();
    await saveBankTransferDestination(client, {
      attempt: {},
      propertyId: "property",
      enabled: false,
      details: blank,
      saved: null,
    });
    expect(client.put).not.toHaveBeenCalled();
  });
  it.each(["bank-only", "bank and provider"])(
    "saves raw fields only to the dedicated endpoint for %s",
    async () => {
      const client = transport();
      await saveBankTransferDestination(client, {
        attempt: {},
        propertyId: " property ",
        enabled: true,
        details,
        saved: null,
      });
      expect(client.put).toHaveBeenCalledWith(
        "/api/finance/properties/property/bank-transfer-destination",
        { action: "replace", details, expectedVersion: 0, commandId: expect.any(String) },
      );
    },
  );
  it("keeps a masked existing account without reading or rewriting raw details", async () => {
    const client = transport();
    expect(
      await saveBankTransferDestination(client, {
        attempt: {},
        propertyId: "property",
        enabled: true,
        details: blank,
        saved,
      }),
    ).toEqual(saved);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.put).not.toHaveBeenCalled();
  });
  it("rejects partial replacements before sending secrets", async () => {
    const client = transport();
    await expect(
      saveBankTransferDestination(client, {
        attempt: {},
        propertyId: "property",
        enabled: true,
        details: { ...blank, bankName: "New bank" },
        saved,
      }),
    ).rejects.toThrow("complete bank details");
    expect(client.put).not.toHaveBeenCalled();
  });
  it("uses the loaded version to detect concurrent edits and disables without secrets", async () => {
    const client = transport();
    await saveBankTransferDestination(client, {
      attempt: {},
      propertyId: "property",
      enabled: false,
      details,
      saved,
    });
    expect(client.put.mock.calls[0]?.[1]).toEqual({
      action: "disable",
      expectedVersion: 5,
      commandId: expect.any(String),
    });
  });
});
