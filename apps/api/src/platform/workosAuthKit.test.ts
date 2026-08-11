import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkOSAuthKitClient } from "./workosAuthKit.js";

const workosMocks = vi.hoisted(() => ({
  WorkOS: vi.fn(),
  authenticate: vi.fn(),
  loadSealedSession: vi.fn(),
  listSessions: vi.fn(),
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
    workosMocks.listSessions.mockReset();
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

  it("refreshes an expired access token while restoring a sealed browser session", async () => {
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
    workosMocks.authenticate.mockResolvedValue({
      authenticated: false,
      reason: "invalid_jwt",
    });
    workosMocks.refresh.mockResolvedValue({
      authenticated: true,
      accessToken: "refreshed-access-token",
      sealedSession: "refreshed-sealed-session",
      session: { accessToken: "nested-access-token" },
      user: {
        id: "user_workos_creator",
        email: "creator@example.com",
        emailVerified: true,
        name: "Creator",
      },
      sessionId: "session_refreshed",
    });

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(
      client.authenticateSession({ sealedSession: "expired-access-token-session" }),
    ).resolves.toMatchObject({
      accessToken: "refreshed-access-token",
      sealedSession: "refreshed-sealed-session",
      sessionId: "session_refreshed",
      user: { id: "user_workos_creator" },
    });
    expect(workosMocks.refresh).toHaveBeenCalledWith({
      cookiePassword: "a".repeat(32),
      organizationId: undefined,
    });
  });

  it.each([
    ["name", { name: "JWTExpired" }],
    ["code", { code: "ERR_JWT_EXPIRED" }],
  ])(
    "refreshes when sealed-session authentication throws an expired-token error identified by %s",
    async (_discriminator, errorShape) => {
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
      const error = Object.assign(new Error("JWT expired"), errorShape);
      workosMocks.authenticate.mockRejectedValue(error);
      workosMocks.refresh.mockResolvedValue({
        authenticated: true,
        accessToken: "refreshed-access-token",
        sealedSession: "refreshed-sealed-session",
        session: { accessToken: "nested-access-token" },
        user: {
          id: "user_workos_creator",
          email: "creator@example.com",
          emailVerified: true,
          name: "Creator",
        },
        sessionId: "session_refreshed",
      });

      const client = createWorkOSAuthKitClient({
        apiKey: "sk_test",
        clientId: "client_test",
        cookiePassword: "a".repeat(32),
      });

      await expect(
        client.authenticateSession({ sealedSession: "expired-access-token-session" }),
      ).resolves.toMatchObject({
        accessToken: "refreshed-access-token",
        sealedSession: "refreshed-sealed-session",
        sessionId: "session_refreshed",
      });
      expect(workosMocks.refresh).toHaveBeenCalledWith({
        cookiePassword: "a".repeat(32),
        organizationId: undefined,
      });
    },
  );

  it("does not refresh an invalid sealed-session cookie", async () => {
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
    workosMocks.authenticate.mockResolvedValue({
      authenticated: false,
      reason: "invalid_session_cookie",
    });

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(
      client.authenticateSession({ sealedSession: "invalid-session" }),
    ).resolves.toBeNull();
    expect(workosMocks.refresh).not.toHaveBeenCalled();
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
    expect(workosMocks.refresh).not.toHaveBeenCalled();
  });

  it("checks the provider session before issuing a cross-app handoff", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          listSessions: workosMocks.listSessions,
        },
      };
    });
    workosMocks.listSessions.mockImplementation(async (_userId, options) =>
      options?.after === "next-page"
        ? {
            data: [{ id: "session_revoked", status: "revoked" }],
            listMetadata: {},
          }
        : {
            data: [{ id: "session_active", status: "active" }],
            listMetadata: { after: "next-page" },
          },
    );

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(
      client.isSessionActive({
        sessionId: "session_active",
        workosUserId: "user_workos_hotel",
      }),
    ).resolves.toBe(true);
    await expect(
      client.isSessionActive({
        sessionId: "session_revoked",
        workosUserId: "user_workos_hotel",
      }),
    ).resolves.toBe(false);
    expect(workosMocks.listSessions).toHaveBeenCalledWith("user_workos_hotel", { limit: 100 });
    expect(workosMocks.listSessions).toHaveBeenCalledWith("user_workos_hotel", {
      after: "next-page",
      limit: 100,
    });
    expect(workosMocks.listSessions).toHaveBeenCalledTimes(3);
  });

  it("rethrows unclassified sealed-session errors without refreshing", async () => {
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
    const error = new Error("WorkOS unavailable");
    workosMocks.authenticate.mockRejectedValue(error);

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(client.authenticateSession({ sealedSession: "valid-session" })).rejects.toBe(
      error,
    );
    expect(workosMocks.refresh).not.toHaveBeenCalled();
  });

  it("treats expired sealed-session refreshes as invalid sessions", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          loadSealedSession: workosMocks.loadSealedSession,
        },
      };
    });
    workosMocks.loadSealedSession.mockReturnValue({
      refresh: workosMocks.refresh,
    });
    workosMocks.refresh.mockRejectedValue(
      Object.assign(new Error("JWT expired"), { code: "ERR_JWT_EXPIRED" }),
    );

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(client.refreshSession({ sealedSession: "stale-session" })).resolves.toBeNull();
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
