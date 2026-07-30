import { describe, expect, it } from "vitest";

import {
  PROPERTY_SETUP_DRAFT_MAX_DEPTH,
  PROPERTY_SETUP_DRAFT_MAX_NODES,
  snapshotPropertySetupDraftRequest,
} from "./propertySetupDraftRequestSafety.js";

describe("property setup draft request safety", () => {
  it("returns a plain JSON snapshot and allows ordinary hotel prose", () => {
    const value = { description: "A small hotel beside a secret garden.", pending: null };

    expect(snapshotPropertySetupDraftRequest(value)).toEqual({ ok: true, value });
  });

  it("returns the single serialized snapshot when a getter changes", () => {
    let reads = 0;
    const value = {
      get description() {
        reads += 1;
        return reads === 1 ? "A safe snapshot." : "sk_live_1234567890abcdefghij";
      },
    };

    expect(snapshotPropertySetupDraftRequest(value)).toEqual({
      ok: true,
      value: { description: "A safe snapshot." },
    });
    expect(reads).toBe(1);
  });

  it.each([
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    ),
    Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error("getter");
      },
    }),
  ])("rejects hostile object access without throwing", (value) => {
    expect(snapshotPropertySetupDraftRequest(value)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  it.each([undefined, 1n, Number.NaN, Number.POSITIVE_INFINITY, { value: undefined }])(
    "rejects non-JSON values",
    (value) => {
      expect(snapshotPropertySetupDraftRequest(value)).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    },
  );

  it("rejects cyclic values without throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(snapshotPropertySetupDraftRequest(cyclic)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  it("measures the UTF-8 request size", () => {
    expect(snapshotPropertySetupDraftRequest({ value: "ü".repeat(33_000) })).toMatchObject({
      ok: false,
      error: { code: "payload_too_large" },
    });
  });

  it("caps traversed nodes before deeper validation", () => {
    const value = Array.from({ length: PROPERTY_SETUP_DRAFT_MAX_NODES }, () => null);

    expect(snapshotPropertySetupDraftRequest(value)).toMatchObject({
      ok: false,
      error: { code: "payload_too_large" },
    });
  });

  it("rejects excessive nesting", () => {
    let nested: unknown = "value";
    for (let index = 0; index <= PROPERTY_SETUP_DRAFT_MAX_DEPTH; index += 1) {
      nested = { next: nested };
    }

    expect(snapshotPropertySetupDraftRequest(nested)).toMatchObject({
      ok: false,
      error: { code: "payload_too_deep" },
    });
  });

  it.each([
    "sk_live_1234567890abcdefghij",
    "whsec_1234567890abcdefghij",
    "Bearer 1234567890abcdefghijklmnop",
    "eyJabcdefghijk.eyJabcdefghijk.abcdefghijklmnop",
    "DE89 3704 0044 0532 0130 00",
    "https://user:password@example.com/private",
    "https://media.example/file?X-Amz-Signature=abc",
    "-----BEGIN PRIVATE KEY-----",
  ])("rejects high-confidence sensitive values", (sensitiveValue) => {
    expect(snapshotPropertySetupDraftRequest({ value: sensitiveValue })).toMatchObject({
      ok: false,
      error: { code: "unsafe_payload" },
    });
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects the dangerous object key %s",
    (key) => {
      const value = JSON.parse(`{"${key}":"value"}`);
      expect(snapshotPropertySetupDraftRequest(value)).toMatchObject({
        ok: false,
        error: { code: "unsafe_payload" },
      });
    },
  );
});
