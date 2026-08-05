import { describe, expect, it, vi } from "vitest";

import { createPgPropertySetupFinanceOwnerScopePort } from "./domains/propertySetupFinanceOwnerScope.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";

describe("property setup Finance owner scope", () => {
  it("checks the exact bounded Finance owner boundary", async () => {
    const query = vi.fn(
      async (_request: { text: string; values: unknown[]; query_timeout: number }) => ({
        rows: [{ authorized: true }],
        rowCount: 1,
      }),
    );
    const scope = createPgPropertySetupFinanceOwnerScopePort({ pool: { query } as never });

    await expect(scope.hasPaymentOwnerScope({ organizationId, propertyId })).resolves.toBe(true);
    expect(query.mock.calls[0]![0]).toMatchObject({
      values: [organizationId, propertyId],
      query_timeout: 5_000,
    });
    expect(query.mock.calls[0]![0].text).toContain(
      "resource.relationship IN ('owner', 'operator', 'finance_manager')",
    );
  });

  it("fails closed before SQL for malformed scope and on provider failure", async () => {
    const query = vi.fn(async () => {
      throw new Error("unavailable");
    });
    const scope = createPgPropertySetupFinanceOwnerScopePort({ pool: { query } as never });

    await expect(
      scope.hasPaymentOwnerScope({ organizationId, propertyId: "not-a-uuid" }),
    ).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
    await expect(scope.hasPaymentOwnerScope({ organizationId, propertyId })).resolves.toBe(false);
  });
});
