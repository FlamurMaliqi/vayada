import { describe, expect, it } from "vitest";

import {
  BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS,
  BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES,
  createBookingGuestPolicyAbsentSourceRevision,
  createBookingGuestPolicySourceRevision,
  parseBookingGuestPolicyCatalogProfileEvidenceResult,
  parseBookingGuestPolicyCurrentSourceRevision,
  parseBookingGuestPolicyChoices,
  parseBookingGuestPolicyHash,
  bookingArrivalTimeErrors,
} from "./bookingGuestPolicy.js";

const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const choices = {
  defaultGuestLanguage: "de",
  childrenEnabled: true,
  adultAgeThreshold: 18,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
} as const;

describe("Booking guest-policy contract", () => {
  it("preserves optional arrival windows and rejects malformed or reversed bounds", () => {
    const window = { ...choices, checkInUntil: "23:00", checkOutFrom: "07:00" };
    expect(parseBookingGuestPolicyChoices(window)).toEqual(window);
    expect(parseBookingGuestPolicyChoices(choices)).toEqual(choices);
    for (const change of [
      { checkInUntil: "14:00" },
      { checkInUntil: "15:00" },
      { checkOutFrom: "11:00" },
      { checkOutFrom: "12:00" },
      { checkInUntil: "" },
      { checkOutFrom: null },
      { checkInTime: "" },
      { checkInUntil: "24:00" },
      { checkOutFrom: "07:00:00" },
    ]) {
      expect(parseBookingGuestPolicyChoices({ ...window, ...change })).toBeNull();
      expect(bookingArrivalTimeErrors({ ...window, ...change }).length).toBeGreaterThan(0);
    }
    const getter = Object.defineProperty({ ...choices }, "checkInUntil", {
      enumerable: true,
      get() {
        throw new Error("must not execute accessors");
      },
    });
    expect(parseBookingGuestPolicyChoices(getter)).toBeNull();
  });

  it("owns one immutable guest-interface capability list and optional-field defaults", () => {
    expect(BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES).toEqual(["en", "de", "fr", "es", "id", "nl"]);
    expect(BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS).toEqual({
      phoneRequired: true,
      arrivalTimeEnabled: false,
      specialRequestsEnabled: true,
    });
    expect(Object.isFrozen(BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES)).toBe(true);
    expect(Object.isFrozen(BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS)).toBe(true);
  });

  it("strictly parses explicit guest choices without comparing arrival and departure times", () => {
    const parsed = parseBookingGuestPolicyChoices(choices);
    expect(parsed).toEqual(choices);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      parseBookingGuestPolicyChoices({
        ...choices,
        checkInTime: "23:59",
        checkOutTime: "00:00",
      }),
    ).not.toBeNull();
    expect(
      parseBookingGuestPolicyChoices({
        ...choices,
        childrenEnabled: false,
        adultAgeThreshold: 18,
      }),
    ).not.toBeNull();
  });

  it("rejects unsupported language, incomplete child policy, invalid times, and extra fields", () => {
    for (const invalid of [
      { ...choices, defaultGuestLanguage: "it" },
      { ...choices, adultAgeThreshold: null },
      { ...choices, adultAgeThreshold: 22 },
      { ...choices, checkInTime: "24:00" },
      { ...choices, checkOutTime: "11:00:00" },
      { ...choices, employeeLanguage: "en" },
    ]) {
      expect(parseBookingGuestPolicyChoices(invalid)).toBeNull();
    }
    expect(
      parseBookingGuestPolicyChoices({
        ...choices,
        childrenEnabled: false,
        adultAgeThreshold: null,
      }),
    ).not.toBeNull();
  });

  it("creates canonical Booking source coordinates and parses only prefixed hashes", () => {
    expect(createBookingGuestPolicySourceRevision(propertyId.toUpperCase(), 7)).toEqual({
      ownerDomain: "booking",
      entityType: "guest_policy_revision",
      entityId: propertyId,
      revision: "guest-policy:7",
    });
    expect(() => createBookingGuestPolicySourceRevision(propertyId, 0)).toThrow();
    expect(parseBookingGuestPolicyHash(`sha256:${"a".repeat(64)}`)).toBe(
      `sha256:${"a".repeat(64)}`,
    );
    expect(parseBookingGuestPolicyHash("a".repeat(64))).toBeNull();
    expect(parseBookingGuestPolicyHash(`sha256:${"A".repeat(64)}`)).toBeNull();
  });

  it("represents an unconfigured aggregate without inventing revision zero", () => {
    const absent = createBookingGuestPolicyAbsentSourceRevision(propertyId.toUpperCase());
    expect(absent).toEqual({
      ownerDomain: "booking",
      entityType: "guest_policy_revision",
      entityId: propertyId,
      revision: "guest-policy:absent",
    });
    expect(Object.isFrozen(absent)).toBe(true);
    expect(createBookingGuestPolicyAbsentSourceRevision(propertyId)).toEqual(absent);
    expect(parseBookingGuestPolicyCurrentSourceRevision(absent, propertyId)).toEqual(absent);
    expect(
      parseBookingGuestPolicyCurrentSourceRevision(
        createBookingGuestPolicySourceRevision(propertyId, 1),
        propertyId,
      ),
    ).toEqual(createBookingGuestPolicySourceRevision(propertyId, 1));
    for (const invalid of [
      { ...absent, revision: "guest-policy:0" },
      { ...absent, revision: "guest-policy:01" },
      { ...absent, revision: "guest-policy:ABSENT" },
      { ...absent, entityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      { ...absent, extra: true },
    ]) {
      expect(parseBookingGuestPolicyCurrentSourceRevision(invalid, propertyId)).toBeNull();
    }
    const accessor = { ...absent };
    Object.defineProperty(accessor, "revision", {
      enumerable: true,
      get: () => "guest-policy:absent",
    });
    expect(parseBookingGuestPolicyCurrentSourceRevision(accessor, propertyId)).toBeNull();
    expect(
      parseBookingGuestPolicyCurrentSourceRevision(
        createBookingGuestPolicySourceRevision(propertyId, 1),
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ),
    ).toBeNull();
  });

  it("strictly parses scope-bound Catalog profile evidence", () => {
    const value = {
      outcome: "available",
      evidence: {
        source: {
          ownerDomain: "hotel_catalog",
          entityType: "property_profile",
          entityId: propertyId,
          revision: "profile:3",
        },
        timeZone: "Europe/Berlin",
      },
    };
    expect(parseBookingGuestPolicyCatalogProfileEvidenceResult(value, propertyId)).toEqual(value);
    expect(
      parseBookingGuestPolicyCatalogProfileEvidenceResult(
        {
          ...value,
          evidence: {
            ...value.evidence,
            source: { ...value.evidence.source, entityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
          },
        },
        propertyId,
      ),
    ).toBeNull();
    expect(
      parseBookingGuestPolicyCatalogProfileEvidenceResult(
        { ...value, evidence: { ...value.evidence, extra: true } },
        propertyId,
      ),
    ).toBeNull();
  });
});
