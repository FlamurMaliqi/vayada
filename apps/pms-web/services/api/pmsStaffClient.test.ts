import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));

vi.mock("./pmsOperationsClient", () => ({
  pmsOperationsClient: { get: mocks.get, patch: mocks.patch },
  pmsOperationsRequestOptions: { cache: "no-store" },
}));

import { getPmsStaffRoster, updatePmsStaffStatus } from "./pmsStaffClient";

describe("PMS staff roster client", () => {
  it("reads the identity-owned roster without a property-scoped endpoint", async () => {
    const members = [{ id: "member-1", email: "staff@example.com" }];
    mocks.get.mockResolvedValueOnce({ members });

    await expect(getPmsStaffRoster()).resolves.toBe(members);
    expect(mocks.get).toHaveBeenCalledWith("/api/identity/staff/members", {
      cache: "no-store",
    });
  });

  it("updates canonical staff status with a unique idempotency key", async () => {
    const response = { membershipId: "member/1", status: "deactivated" as const };
    mocks.patch.mockResolvedValueOnce(response);

    await expect(updatePmsStaffStatus("member/1", "deactivated")).resolves.toBe(response);
    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/identity/staff/members/member%2F1/status",
      { status: "deactivated" },
      {
        cache: "no-store",
        headers: expect.objectContaining({
          "Idempotency-Key": expect.stringMatching(/^pms-staff-status:/),
        }),
      },
    );
  });
});
