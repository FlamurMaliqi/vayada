import { describe, expect, it } from "vitest";

import {
  BOOKING_SETUP_DRAFT_MAX_AGE_MS,
  bookingSetupDraftKey,
  clearBookingSetupDraft,
  readBookingSetupDraft,
  type BookingSetupDraftScope,
  writeBookingSetupDraft,
} from "./bookingSetupDraft";

const OWNER_A_NEW_PROPERTY: BookingSetupDraftScope = {
  userId: "user_a",
  organizationId: "org_alpenrose",
};

describe("Booking setup draft", () => {
  it("round-trips a property-scoped serializable draft", () => {
    const storage = memoryStorage();
    const scope = { ...OWNER_A_NEW_PROPERTY, propertyId: "property one" };
    writeBookingSetupDraft(storage, scope, {
      step: 4,
      values: {
        heroHeading: "Stay with us",
        benefits: ["Breakfast"],
      },
    });

    expect(readBookingSetupDraft(storage, scope)).toMatchObject({
      version: 2,
      step: 4,
      values: {
        heroHeading: "Stay with us",
        benefits: ["Breakfast"],
      },
    });
    expect(bookingSetupDraftKey(scope)).toContain("property%20one");
  });

  it("drops File-like objects and temporary blob URLs", () => {
    const storage = memoryStorage();
    writeBookingSetupDraft(
      storage,
      { ...OWNER_A_NEW_PROPERTY, propertyId: "property_1" },
      {
        step: 2,
        values: {
          heroImage: "blob:https://admin.booking.localhost/temporary",
          file: new (class FileLike {})(),
          addon: { name: "Breakfast", image: "https://cdn.example/breakfast.jpg" },
        },
      },
    );

    expect(
      readBookingSetupDraft(storage, { ...OWNER_A_NEW_PROPERTY, propertyId: "property_1" })?.values,
    ).toEqual({
      addon: { name: "Breakfast", image: "https://cdn.example/breakfast.jpg" },
    });
  });

  it("clears only the selected property's draft", () => {
    const storage = memoryStorage();
    const first = { ...OWNER_A_NEW_PROPERTY, propertyId: "property_1" };
    const second = { ...OWNER_A_NEW_PROPERTY, propertyId: "property_2" };
    writeBookingSetupDraft(storage, first, { step: 1, values: {} });
    writeBookingSetupDraft(storage, second, { step: 1, values: {} });

    clearBookingSetupDraft(storage, first);

    expect(readBookingSetupDraft(storage, first)).toBeNull();
    expect(readBookingSetupDraft(storage, second)).not.toBeNull();
  });

  it("does not restore a new-property draft after an account or organization switch", () => {
    const storage = memoryStorage();
    writeBookingSetupDraft(storage, OWNER_A_NEW_PROPERTY, {
      step: 1,
      values: { reservationEmail: "private@alpenrose.example" },
    });

    expect(
      readBookingSetupDraft(storage, {
        userId: "user_b",
        organizationId: OWNER_A_NEW_PROPERTY.organizationId,
      }),
    ).toBeNull();
    expect(
      readBookingSetupDraft(storage, {
        userId: OWNER_A_NEW_PROPERTY.userId,
        organizationId: "org_riverside",
      }),
    ).toBeNull();
    expect(readBookingSetupDraft(storage, OWNER_A_NEW_PROPERTY)?.values).toEqual({
      reservationEmail: "private@alpenrose.example",
    });
  });

  it("expires and removes stale drafts", () => {
    const storage = memoryStorage();
    const savedAt = Date.parse("2026-07-01T00:00:00.000Z");
    writeBookingSetupDraft(
      storage,
      OWNER_A_NEW_PROPERTY,
      { step: 2, values: { propertyName: "Hotel Alpenrose" } },
      savedAt,
    );

    expect(
      readBookingSetupDraft(
        storage,
        OWNER_A_NEW_PROPERTY,
        savedAt + BOOKING_SETUP_DRAFT_MAX_AGE_MS,
      ),
    ).toBeNull();
    expect(storage.getItem(bookingSetupDraftKey(OWNER_A_NEW_PROPERTY))).toBeNull();
  });
});

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}
