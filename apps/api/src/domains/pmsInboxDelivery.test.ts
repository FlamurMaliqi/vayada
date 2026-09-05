import { describe, expect, it } from "vitest";

import {
  nextPmsInboxDeliveryRunAt,
  pmsInboxDeliveryJobKey,
  pmsInboxProviderIdempotencyReference,
  projectPmsInboxDeliveryFailure,
  type PmsInboxDeliveryFailure,
} from "./pmsInboxDelivery.js";

describe("PMS Inbox delivery contract", () => {
  it("uses one stable job and provider identity per accepted message", () => {
    expect(pmsInboxDeliveryJobKey("message_1")).toBe(
      "pms.guest-message.deliver:message:message_1:manual-send:v1",
    );
    expect(pmsInboxProviderIdempotencyReference("message_1")).toBe("message:message_1");
  });

  it("retries only transient failures while budget remains", () => {
    expect(projectPmsInboxDeliveryFailure("transient_provider_failure", 1)).toEqual({
      attemptOutcome: "transient_failure",
      state: "retrying",
      reasonCode: "transient_provider_failure",
      retry: true,
      deadLetter: false,
    });
    expect(projectPmsInboxDeliveryFailure("transient_provider_failure", 5)).toEqual({
      attemptOutcome: "terminal_failure",
      state: "failed",
      reasonCode: "retry_exhausted",
      retry: false,
      deadLetter: true,
    });
  });

  it.each<[PmsInboxDeliveryFailure, string | null, string, boolean]>([
    ["ambiguous_provider_outcome", "held", "ambiguous_provider_outcome", false],
    ["access_unavailable", "held", "access_unavailable", false],
    ["provider_configuration_unavailable", "held", "provider_configuration_unavailable", false],
    ["resource_deleted", null, "resource_deleted", true],
    ["invalid_delivery_payload", "failed", "invalid_delivery_payload", false],
    ["provider_rejected", "failed", "provider_rejected", false],
  ])("projects %s without an automatic retry", (failure, state, reasonCode, deadLetter) => {
    expect(projectPmsInboxDeliveryFailure(failure, 1)).toMatchObject({
      attemptOutcome: "terminal_failure",
      state,
      reasonCode,
      retry: false,
      deadLetter,
    });
  });

  it("uses bounded exponential backoff with injectable jitter", () => {
    const now = new Date("2026-09-03T00:00:00.000Z");
    expect(nextPmsInboxDeliveryRunAt(now, 1, () => 0).toISOString()).toBe(
      "2026-09-03T00:00:24.000Z",
    );
    expect(nextPmsInboxDeliveryRunAt(now, 2, () => 0.5).toISOString()).toBe(
      "2026-09-03T00:01:00.000Z",
    );
    expect(nextPmsInboxDeliveryRunAt(now, 20, () => 1).toISOString()).toBe(
      "2026-09-03T00:18:00.000Z",
    );
  });
});
