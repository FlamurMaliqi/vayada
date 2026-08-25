import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkOSStaffRemovalProvider } from "./workosStaffRemoval.js";

const workosMocks = vi.hoisted(() => {
  class NotFoundException extends Error {}
  return {
    NotFoundException,
    WorkOS: vi.fn(),
    getOrganizationMembership: vi.fn(),
    deleteOrganizationMembership: vi.fn(),
  };
});

vi.mock("@workos-inc/node", () => ({
  NotFoundException: workosMocks.NotFoundException,
  WorkOS: workosMocks.WorkOS,
}));

describe("createWorkOSStaffRemovalProvider", () => {
  beforeEach(() => {
    workosMocks.WorkOS.mockReset();
    workosMocks.getOrganizationMembership.mockReset();
    workosMocks.deleteOrganizationMembership.mockReset();
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          getOrganizationMembership: workosMocks.getOrganizationMembership,
          deleteOrganizationMembership: workosMocks.deleteOrganizationMembership,
        },
      };
    });
  });

  it("returns only the membership binding and disables SDK retries", async () => {
    workosMocks.getOrganizationMembership.mockResolvedValue({
      id: "om_staff",
      organizationId: "org_hotel",
      userId: "user_staff",
      customAttributes: { secret: "not-returned" },
    });
    const provider = createWorkOSStaffRemovalProvider({ apiKey: "sk_test" });

    await expect(provider.getMembership("om_staff")).resolves.toEqual({
      id: "om_staff",
      organizationId: "org_hotel",
      userId: "user_staff",
    });
    expect(workosMocks.WorkOS).toHaveBeenCalledWith("sk_test", { maxRetries: 0 });
    expect(workosMocks.getOrganizationMembership).toHaveBeenCalledWith("om_staff");
  });

  it("treats lookup and delete not-found responses as convergence", async () => {
    workosMocks.getOrganizationMembership.mockRejectedValue(
      new workosMocks.NotFoundException("not found"),
    );
    workosMocks.deleteOrganizationMembership.mockRejectedValue(
      new workosMocks.NotFoundException("not found"),
    );
    const provider = createWorkOSStaffRemovalProvider({ apiKey: "sk_test" });

    await expect(provider.getMembership("om_absent")).resolves.toBeNull();
    await expect(provider.deleteMembership("om_absent")).resolves.toBe("already_absent");
  });

  it("reports a successful delete and propagates provider failures", async () => {
    workosMocks.deleteOrganizationMembership.mockResolvedValue(undefined);
    const provider = createWorkOSStaffRemovalProvider({ apiKey: "sk_test" });
    await expect(provider.deleteMembership("om_staff")).resolves.toBe("deleted");

    const failure = new Error("provider unavailable");
    workosMocks.getOrganizationMembership.mockRejectedValue(failure);
    workosMocks.deleteOrganizationMembership.mockRejectedValue(failure);
    await expect(provider.getMembership("om_staff")).rejects.toBe(failure);
    await expect(provider.deleteMembership("om_staff")).rejects.toBe(failure);
  });
});
