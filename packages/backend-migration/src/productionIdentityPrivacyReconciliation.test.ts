import { describe, expect, it } from "vitest";

import {
  reconcileIdentityPrivacy,
  type ExistingPrivacyState,
} from "./productionIdentityPrivacyReconciliation.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_ID = "44444444-4444-4444-8444-444444444444";
const EXTRA_ID = "55555555-5555-4555-8555-555555555555";
const JAN = "2026-01-01T00:00:00.000Z";
const FEB = "2026-02-01T00:00:00.000Z";
const MAR = "2026-03-01T00:00:00.000Z";

describe("production identity privacy reconciliation", () => {
  it("preserves newer state and target-owned immutable fields", () => {
    const source = {
      userConsents: [userConsent(JAN, true)],
      cookieConsents: [cookie(SOURCE_ID, MAR, true)],
      consentHistory: [history({ ipAddress: "192.0.2.1", userAgent: "test" })],
      gdprRequests: [gdpr(SOURCE_ID, MAR, "completed")],
    };
    const existing: ExistingPrivacyState = {
      userConsents: [userConsent(FEB, false)],
      cookieConsents: [{ ...cookie(TARGET_ID, FEB, false), createdAt: JAN }],
      consentHistory: [
        {
          ...history({ userAgent: "test", ipAddress: "192.0.2.1" }),
          createdAt: "2026-01-01T00:00:00+00:00",
        },
      ],
      gdprRequests: [{ ...gdpr(SOURCE_ID, FEB, "pending"), createdAt: JAN }],
    };

    const plan = reconcileIdentityPrivacy(source, existing);

    expect(plan.blockers).toEqual([]);
    expect(plan.userConsents[0]?.marketingConsent).toBe(false);
    expect(plan.cookieConsents[0]).toMatchObject({
      id: TARGET_ID,
      analytics: true,
      createdAt: JAN,
    });
    expect(plan.consentHistory).toHaveLength(1);
    expect(plan.gdprRequests[0]).toMatchObject({ status: "completed", createdAt: JAN });
  });

  it("blocks equal-time, immutable identity, and final uniqueness conflicts", () => {
    const source = {
      userConsents: [userConsent(FEB, true)],
      cookieConsents: [cookie(SOURCE_ID, FEB, true), cookie(TARGET_ID, MAR, false, "visitor-new")],
      consentHistory: [history({ ipAddress: "192.0.2.1" })],
      gdprRequests: [
        gdpr(SOURCE_ID, FEB, "completed"),
        gdpr(TARGET_ID, MAR, "pending", "duplicate-token"),
      ],
    };
    const existing: ExistingPrivacyState = {
      userConsents: [userConsent(FEB, false)],
      cookieConsents: [cookie(EXTRA_ID, FEB, false), cookie(TARGET_ID, JAN, false, "visitor-old")],
      consentHistory: [history({ ipAddress: "198.51.100.1" })],
      gdprRequests: [
        { ...gdpr(SOURCE_ID, FEB, "completed"), userId: OTHER },
        gdpr(EXTRA_ID, JAN, "pending", "duplicate-token"),
      ],
    };

    const plan = reconcileIdentityPrivacy(source, existing);

    expect(plan.blockers.map((row) => row.code)).toEqual(
      expect.arrayContaining([
        "PRIVACY_EQUAL_TIME_CONFLICT",
        "CONSENT_HISTORY_TARGET_CONFLICT",
        "GDPR_TARGET_IDENTITY_CONFLICT",
        "COOKIE_TARGET_ID_CONFLICT",
        "GDPR_TARGET_TOKEN_CONFLICT",
      ]),
    );
    expect(
      reconcileIdentityPrivacy(
        {
          ...source,
          cookieConsents: [...source.cookieConsents].reverse(),
          gdprRequests: [...source.gdprRequests].reverse(),
        },
        {
          ...existing,
          cookieConsents: [...existing.cookieConsents].reverse(),
          gdprRequests: [...existing.gdprRequests].reverse(),
        },
      ),
    ).toEqual(plan);
  });
});

function userConsent(updatedAt: string, marketingConsent: boolean) {
  return {
    userId: USER,
    termsAcceptedAt: JAN,
    termsVersion: "v1",
    privacyAcceptedAt: JAN,
    privacyVersion: "v1",
    marketingConsent,
    marketingConsentAt: JAN,
    createdAt: JAN,
    updatedAt,
  };
}
function cookie(id: string, updatedAt: string, analytics: boolean, visitorId = "visitor-1") {
  return {
    id,
    visitorId,
    userId: USER,
    necessary: true as const,
    functional: false,
    analytics,
    marketing: false,
    createdAt: JAN,
    updatedAt,
  };
}
function history(metadata: Record<string, string>) {
  return {
    id: SOURCE_ID,
    userId: USER,
    visitorId: null,
    consentType: "privacy",
    consentGiven: true,
    version: "v1",
    metadata,
    createdAt: JAN,
  };
}
function gdpr(id: string, updatedAt: string, status: string, downloadToken: string | null = null) {
  return {
    id,
    userId: USER,
    requestType: "export",
    status,
    downloadToken,
    requestedAt: JAN,
    processedAt: status === "completed" ? updatedAt : null,
    expiresAt: null,
    ipAddress: "192.0.2.1",
    metadata: {},
    createdAt: JAN,
    updatedAt,
  };
}
