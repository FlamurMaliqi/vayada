import { describe, expect, it } from "vitest";

import {
  canonicalSetupReturnUrl,
  errorForHandoffFailure,
  handoffLoginPath,
  invalidHandoffError,
  isOpaqueHandoffCode,
  isSafeRelativeReturnTo,
  opaqueHandoffReturnTo,
  resolveOpaqueHandoffLocation,
  safeRelativeReturnTo,
} from "./returnTo";

const handoffCode = "7_8FkqvJvK_vOS5Ke4iFAScHY6LmDsQUviRLKfS1dCk";

describe("opaque handoff return targets", () => {
  it("accepts and preserves an exact 43-character base64url code", () => {
    expect(isOpaqueHandoffCode(handoffCode)).toBe(true);
    expect(opaqueHandoffReturnTo(handoffCode)).toBe(`/handoff?code=${handoffCode}`);
    expect(isSafeRelativeReturnTo(`/handoff?code=${handoffCode}`)).toBe(true);
  });

  it("rejects invalid code lengths and non-base64url characters", () => {
    expect(isOpaqueHandoffCode(handoffCode.slice(1))).toBe(false);
    expect(isOpaqueHandoffCode(`${handoffCode}x`)).toBe(false);
    expect(isOpaqueHandoffCode(`${handoffCode.slice(0, -1)}=`)).toBe(false);
    expect(isOpaqueHandoffCode(`${handoffCode.slice(0, -1)}+`)).toBe(false);
    expect(opaqueHandoffReturnTo("not-a-code")).toBeNull();
  });

  it.each([
    `/handoff?code=${handoffCode}&propertyId=property_1`,
    `/handoff?propertyId=property_1&code=${handoffCode}`,
    `/handoff?code=${handoffCode}#organization_id=organization_1`,
    `/handoff?code=${handoffCode}#`,
    `/handoff?code=${handoffCode.replace("_", "%5F")}`,
    `/handoff?code=${handoffCode}%20`,
    `/handoff?code=${handoffCode}&code=${handoffCode}`,
    `/handoff/?code=${handoffCode}`,
    `/foo/../handoff?code=${handoffCode}`,
    `https://vayada.local/handoff?code=${handoffCode}`,
    `//vayada.local/handoff?code=${handoffCode}`,
  ])("rejects non-canonical handoff target %s", (returnTo) => {
    expect(isSafeRelativeReturnTo(returnTo)).toBe(false);
    expect(safeRelativeReturnTo(returnTo, "/dashboard")).toBe("/dashboard");
  });

  it("continues to allow unrelated safe app-local return targets", () => {
    expect(isSafeRelativeReturnTo("/dashboard?view=year#july")).toBe(true);
    expect(isSafeRelativeReturnTo("/marketplace")).toBe(true);
    expect(isSafeRelativeReturnTo("https://example.com/dashboard")).toBe(false);
  });
});

describe("handoffLoginPath", () => {
  it("returns to only the canonical opaque-code handoff route", () => {
    const loginPath = handoffLoginPath(handoffCode);
    expect(loginPath).not.toBeNull();
    const path = new URL(loginPath!, "https://vayada.local");
    expect(path.pathname).toBe("/login");
    expect(path.searchParams.get("auth")).toBe("callback");
    expect(path.searchParams.get("returnTo")).toBe(`/handoff?code=${handoffCode}`);
    expect(path.hash).toBe("");
  });

  it("does not construct a login callback for an invalid code", () => {
    expect(handoffLoginPath("not-a-code")).toBeNull();
  });
});

describe("shared handoff validation", () => {
  it("accepts only the exact opaque-code browser location", () => {
    expect(
      resolveOpaqueHandoffLocation({
        pathname: "/handoff",
        search: `?code=${handoffCode}`,
        hash: "",
      }),
    ).toEqual({
      code: handoffCode,
      loginPath: handoffLoginPath(handoffCode),
    });
    expect(
      resolveOpaqueHandoffLocation({
        pathname: "/handoff",
        search: `?code=${handoffCode}&propertyId=property-1`,
        hash: "",
      }),
    ).toBeNull();
  });

  it("accepts only the canonical setup return URL for the exchanged property", () => {
    const returnUrl = "https://marketplace.localhost/setup?propertyId=property-1";
    expect(canonicalSetupReturnUrl(returnUrl, "property-1", "https://marketplace.localhost")).toBe(
      returnUrl,
    );
    expect(
      canonicalSetupReturnUrl(
        `${returnUrl}&entryProduct=marketplace`,
        "property-1",
        "https://marketplace.localhost",
      ),
    ).toBeNull();
    expect(
      canonicalSetupReturnUrl(returnUrl, "property-2", "https://marketplace.localhost"),
    ).toBeNull();
  });

  it("normalizes invalid and stale handoff failures", () => {
    expect(errorForHandoffFailure({ data: { code: "refresh_plan" } })).toEqual({
      refreshPlan: true,
      message: "Your setup plan changed. Refresh it to continue with the current next step.",
    });
    expect(errorForHandoffFailure({ code: "invalid_handoff" })).toEqual(invalidHandoffError());
  });
});
