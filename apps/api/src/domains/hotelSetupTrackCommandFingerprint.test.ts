import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  hotelSetupTrackRequestFingerprint,
  type HotelSetupTrackRequestFingerprintInput,
} from "./hotelSetupTrackCommandFingerprint.js";

type SafetyCase = {
  id: string;
  selectedTracks?: HotelSetupTrackRequestFingerprintInput["selectedTracks"];
  expectedRevision?: number;
};

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../engineering/fixtures/onboarding-command-safety/cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  baseRequest: HotelSetupTrackRequestFingerprintInput;
  cases: SafetyCase[];
};

describe("hotelSetupTrackRequestFingerprint", () => {
  it("preserves the persisted field order and digest", () => {
    expect(hotelSetupTrackRequestFingerprint(fixture.baseRequest)).toBe(
      "f16e1bc3c98ac36ef87a25a20caf444035431e68a069ae7e77ca69cf4adb7b43",
    );
  });

  it("ignores retry transport and audit metadata", () => {
    const firstAttempt = {
      ...fixture.baseRequest,
      idempotencyKey: "setup-exact-retry",
      requestId: "request-first",
      correlationId: "correlation-first",
      source: "web",
    };
    const retry = {
      ...firstAttempt,
      requestId: "request-retry",
      correlationId: "correlation-retry",
      source: "admin",
    };

    expect(hotelSetupTrackRequestFingerprint(retry)).toBe(
      hotelSetupTrackRequestFingerprint(firstAttempt),
    );
  });

  it.each(["changed_payload", "changed_revision"])(
    "changes identity for the %s fixture",
    (caseId) => {
      const safetyCase = fixture.cases.find(({ id }) => id === caseId);
      expect(safetyCase).toBeDefined();
      const changed = {
        ...fixture.baseRequest,
        ...(safetyCase?.selectedTracks ? { selectedTracks: safetyCase.selectedTracks } : {}),
        ...(safetyCase?.expectedRevision === undefined
          ? {}
          : { expectedRevision: safetyCase.expectedRevision }),
      };

      expect(hotelSetupTrackRequestFingerprint(changed)).not.toBe(
        hotelSetupTrackRequestFingerprint(fixture.baseRequest),
      );
    },
  );

  it("defines the reusable command-safety case vocabulary", () => {
    expect(fixture.cases.map(({ id }) => id)).toEqual([
      "exact_retry",
      "changed_payload",
      "changed_revision",
      "concurrent_stale_write",
      "injected_audit_rollback",
    ]);
  });
});
