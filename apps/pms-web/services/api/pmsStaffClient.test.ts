import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("./pmsOperationsClient", () => ({
  pmsOperationsClient: { get: mocks.get },
  pmsOperationsRequestOptions: { cache: "no-store" },
}));

import { getPmsStaffRoster } from "./pmsStaffClient";

describe("PMS staff roster client", () => {
  it("reads the identity-owned roster without a property-scoped endpoint", async () => {
    const members = [{ id: "member-1", email: "staff@example.com" }];
    mocks.get.mockResolvedValueOnce({ members });

    await expect(getPmsStaffRoster()).resolves.toBe(members);
    expect(mocks.get).toHaveBeenCalledWith("/api/identity/staff/members", {
      cache: "no-store",
    });
  });
});
