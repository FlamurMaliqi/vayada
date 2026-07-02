import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkOSAuthKitClient } from "./workosAuthKit.js";

const workosMocks = vi.hoisted(() => ({
  WorkOS: vi.fn(),
  authenticate: vi.fn(),
  loadSealedSession: vi.fn(),
  refresh: vi.fn(),
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
});
