import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkOSAuthKitClient } from "./workosAuthKit.js";

const workosMocks = vi.hoisted(() => ({
  WorkOS: vi.fn(),
  authenticate: vi.fn(),
  loadSealedSession: vi.fn(),
  refresh: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@workos-inc/node", () => ({
  WorkOS: workosMocks.WorkOS,
}));

describe("createWorkOSAuthKitClient", () => {
  beforeEach(() => {
    workosMocks.WorkOS.mockReset();
    workosMocks.authenticate.mockReset();
    workosMocks.loadSealedSession.mockReset();
    workosMocks.refresh.mockReset();
    workosMocks.updateUser.mockReset();
  });

  it("preserves the selected organization returned by WorkOS refresh", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          loadSealedSession: workosMocks.loadSealedSession,
        },
      };
    });
    workosMocks.loadSealedSession.mockReturnValue({
      authenticate: workosMocks.authenticate,
      refresh: workosMocks.refresh,
    });
    workosMocks.refresh.mockResolvedValue({
      authenticated: true,
      accessToken: "refreshed-access-token",
      organizationId: "org_workos_hotel",
      sealedSession: "refreshed-sealed-session",
      session: {
        accessToken: "nested-access-token",
        refreshToken: "refresh-token",
        user: {
          id: "nested_user",
          email: "nested@example.test",
          emailVerified: false,
          name: "Nested User",
        },
      },
      user: {
        id: "user_workos_hotel",
        email: "hotel@example.com",
        emailVerified: true,
        name: "Hotel Owner",
      },
      sessionId: "session_refreshed",
    });

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(
      client.refreshSession({
        sealedSession: "sealed-session",
        organizationId: "org_workos_hotel",
      }),
    ).resolves.toMatchObject({
      accessToken: "refreshed-access-token",
      organizationId: "org_workos_hotel",
      sealedSession: "refreshed-sealed-session",
      sessionId: "session_refreshed",
      user: {
        id: "user_workos_hotel",
      },
    });
    expect(workosMocks.refresh).toHaveBeenCalledWith({
      cookiePassword: "a".repeat(32),
      organizationId: "org_workos_hotel",
    });
    expect(workosMocks.authenticate).not.toHaveBeenCalled();
  });

  it("treats stale sealed-session JWKS mismatches as invalid sessions", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          loadSealedSession: workosMocks.loadSealedSession,
        },
      };
    });
    workosMocks.loadSealedSession.mockReturnValue({
      authenticate: workosMocks.authenticate,
    });
    const error = new Error("no applicable key found in the JSON Web Key Set");
    Object.defineProperty(error, "name", { value: "JWKSNoMatchingKey" });
    Object.assign(error, { code: "ERR_JWKS_NO_MATCHING_KEY" });
    workosMocks.authenticate.mockRejectedValue(error);

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(
      client.authenticateSession({ sealedSession: "stale-session" }),
    ).resolves.toBeNull();
  });

  it("updates both structured and display names", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          updateUser: workosMocks.updateUser,
        },
      };
    });
    workosMocks.updateUser.mockResolvedValue({});
    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await client.updateUserName({
      workosUserId: "user_workos_hotel",
      firstName: "Mary Jane",
      lastName: "Watson",
    });

    expect(workosMocks.updateUser).toHaveBeenCalledWith({
      userId: "user_workos_hotel",
      name: "Mary Jane Watson",
      firstName: "Mary Jane",
      lastName: "Watson",
    });
  });
});
