import { describe, expect, it } from "vitest";

import {
  PLATFORM_BOOTSTRAP_CONFIRM,
  PLATFORM_ORGANIZATION_ID,
  PLATFORM_RESOURCE_ID,
  PLATFORM_RESOURCE_RELATIONSHIP,
  PLATFORM_WORKOS_ROLE_SLUG,
  mapLegacyUserStatus,
  platformIdentityBootstrapConfirm,
  resolveLegacyAuthConnectionString,
  selectRequestedPlatformUsersByEmail,
} from "./platformIdentityBootstrap.js";

describe("platform identity bootstrap constants", () => {
  it("uses stable platform identifiers and an explicit apply guard", () => {
    expect(PLATFORM_ORGANIZATION_ID).toBe("00000000-0000-0000-0000-000000000001");
    expect(PLATFORM_RESOURCE_ID).toBe("vayada");
    expect(PLATFORM_RESOURCE_RELATIONSHIP).toBe("operator");
    expect(PLATFORM_WORKOS_ROLE_SLUG).toBe("admin");
    expect(PLATFORM_BOOTSTRAP_CONFIRM).toBe("platform-identity-bootstrap:v1");
  });
});

describe("target platform admin selection", () => {
  const activeUser = {
    id: "active-user",
    email: "Admin@Example.com",
    name: "Admin",
    targetStatus: "active" as const,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };

  it("selects the single active target user and ignores deleted duplicates", () => {
    expect(
      selectRequestedPlatformUsersByEmail(
        [
          { ...activeUser, id: "deleted-1", targetStatus: "deleted" },
          activeUser,
          { ...activeUser, id: "deleted-2", targetStatus: "deleted" },
        ],
        [" admin@example.com "],
      ),
    ).toEqual([activeUser]);
  });

  it("rejects multiple active target users for the requested admin email", () => {
    expect(() =>
      selectRequestedPlatformUsersByEmail(
        [activeUser, { ...activeUser, id: "other-active" }],
        ["admin@example.com"],
      ),
    ).toThrow("Multiple active target identity users found for admin email admin@example.com.");
  });

  it("binds an admin-email grant to the apply confirmation", () => {
    expect(platformIdentityBootstrapConfirm([" Admin@Example.com "])).toBe(
      "platform-identity-bootstrap:v1:admin-email:admin@example.com",
    );
  });

  it("never loads legacy platform users in exact admin-email mode", () => {
    expect(
      resolveLegacyAuthConnectionString("postgresql://legacy", ["admin@example.com"]),
    ).toBeUndefined();
    expect(resolveLegacyAuthConnectionString("postgresql://legacy")).toBe("postgresql://legacy");
  });
});

describe("mapLegacyUserStatus", () => {
  it.each([
    ["verified", "active"],
    ["active", "active"],
    ["pending", "pending"],
    ["suspended", "suspended"],
    ["rejected", "deleted"],
    ["deleted", "deleted"],
  ] as const)("maps %s to %s", (legacy, target) => {
    expect(mapLegacyUserStatus(legacy)).toBe(target);
  });

  it("rejects unknown legacy states", () => {
    expect(() => mapLegacyUserStatus("surprise")).toThrow(
      "Unsupported legacy user status surprise.",
    );
  });
});
