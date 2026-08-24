import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkOSStaffInvitationProvider } from "./workosStaffInvitations.js";

const workosMocks = vi.hoisted(() => ({
  WorkOS: vi.fn(),
  sendInvitation: vi.fn(),
}));

vi.mock("@workos-inc/node", () => ({ WorkOS: workosMocks.WorkOS }));

describe("createWorkOSStaffInvitationProvider", () => {
  beforeEach(() => {
    workosMocks.WorkOS.mockReset();
    workosMocks.sendInvitation.mockReset();
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return { userManagement: { sendInvitation: workosMocks.sendInvitation } };
    });
  });

  it("disables retries and returns no provider secret or acceptance URL", async () => {
    workosMocks.sendInvitation.mockResolvedValue({
      id: "invitation_workos",
      email: "staff@example.com",
      organizationId: "org_workos",
      inviterUserId: "user_workos_owner",
      roleSlug: "hotel_member",
      state: "pending",
      expiresAt: "2026-08-31T00:00:00.000Z",
      token: "provider-secret",
      acceptInvitationUrl: "https://id.example.test/accept/provider-secret",
    });
    const provider = createWorkOSStaffInvitationProvider({ apiKey: "sk_test" });

    const response = await provider.sendInvitation({
      invitationId: "internal-invitation",
      email: "staff@example.com",
      organizationId: "org_workos",
      inviterUserId: "user_workos_owner",
      roleSlug: "hotel_member",
      expiresInDays: 7,
    });

    expect(workosMocks.WorkOS).toHaveBeenCalledWith("sk_test", { maxRetries: 0 });
    expect(workosMocks.sendInvitation).toHaveBeenCalledOnce();
    expect(workosMocks.sendInvitation).toHaveBeenCalledWith({
      email: "staff@example.com",
      organizationId: "org_workos",
      inviterUserId: "user_workos_owner",
      roleSlug: "hotel_member",
      expiresInDays: 7,
    });
    expect(response).toEqual({
      invitationId: "invitation_workos",
      email: "staff@example.com",
      organizationId: "org_workos",
      inviterUserId: "user_workos_owner",
      roleSlug: "hotel_member",
      state: "pending",
      expiresAt: "2026-08-31T00:00:00.000Z",
    });
    expect(JSON.stringify(response)).not.toMatch(/provider-secret|acceptInvitationUrl/);
  });

  it("rejects a response that cannot be safely bound", async () => {
    workosMocks.sendInvitation.mockResolvedValue({
      id: "invitation_workos",
      email: "staff@example.com",
      organizationId: "org_workos",
      inviterUserId: null,
      roleSlug: "hotel_member",
      state: "pending",
      expiresAt: "2026-08-31T00:00:00.000Z",
    });
    const provider = createWorkOSStaffInvitationProvider({ apiKey: "sk_test" });

    await expect(
      provider.sendInvitation({
        invitationId: "internal-invitation",
        email: "staff@example.com",
        organizationId: "org_workos",
        inviterUserId: "user_workos_owner",
        roleSlug: "hotel_member",
        expiresInDays: 7,
      }),
    ).rejects.toThrow("WorkOS staff invitation response is not delivery-bindable");
  });
});
