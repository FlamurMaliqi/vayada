import { describe, expect, it } from "vitest";

import {
  CHANNEX_MANAGEMENT_CONTRACT_VERSION,
  CHANNEX_MANAGEMENT_OPERATION_TYPES,
  buildChannexManagementJobKey,
} from "./index.js";

describe("PMS Channex management contract", () => {
  it("keeps provider management versioned and webhook intake out of the command set", () => {
    expect(CHANNEX_MANAGEMENT_CONTRACT_VERSION).toBe("pms-channex-management.v1");
    expect(CHANNEX_MANAGEMENT_OPERATION_TYPES).toEqual([
      "enable",
      "disable",
      "provision",
      "setup_google",
      "sync_ari",
      "sync_bookings",
      "update_markups",
      "install_messaging",
    ]);
    expect(CHANNEX_MANAGEMENT_OPERATION_TYPES).not.toContain("promote_webhook");
  });

  it("builds a property-scoped durable idempotency key", () => {
    expect(
      buildChannexManagementJobKey({
        propertyId: "property-1",
        operationType: "sync_ari",
        idempotencyKey: "manual-2026-08-13",
      }),
    ).toBe("channex.management:sync_ari:property:property-1:manual-2026-08-13:v1");
  });
});
