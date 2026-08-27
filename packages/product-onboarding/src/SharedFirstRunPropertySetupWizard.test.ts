import { describe, expect, it } from "vitest";

import {
  blockInlineSetupUnload,
  canLeaveInlineSetupTask,
  canConfirmLocation,
  createProfileFromDraft,
  hasMapCoordinates,
  idempotencyKeyForRetry,
  INLINE_SETUP_STALE_SAVE_MESSAGE,
  isInlineSetupTaskEditable,
  isInlineSetupTaskSaveCurrent,
  isInlineSetupTaskSelectable,
  locationResetForManualAddressEdit,
  mergeTrackSelectionAfterConflict,
  normalizedPhoneNumber,
  phoneWithCountryCallingCode,
  previousEditableSetupTaskId,
  profileUpdateFromDraft,
  recommendedInlineSetupTaskId,
  setupErrorMessage,
  validateProfileDraft,
} from "./SharedFirstRunPropertySetupWizard";

describe("idempotencyKeyForRetry", () => {
  it("keeps one key for retries and creates a new key only after reset", () => {
    let sequence = 0;
    const create = () => `key-${++sequence}`;
    const first = idempotencyKeyForRetry(null, create);

    expect(idempotencyKeyForRetry(first, create)).toBe(first);
    expect(idempotencyKeyForRetry(null, create)).toBe("key-2");
  });
});

describe("property create conflict recovery", () => {
  it("translates conflicts, server failures, and network failures into useful messages", () => {
    expect(
      setupErrorMessage({
        status: 409,
        data: { code: "command_in_progress" },
      }),
    ).toContain("still finishing");
    expect(
      setupErrorMessage({
        status: 409,
        data: { code: "idempotency_key_conflict" },
      }),
    ).toContain("setup changed during this save");
    expect(
      setupErrorMessage({
        status: 409,
        data: { code: "private_contact_conflict", detail: "Publish this contact first." },
      }),
    ).toBe("Publish this contact first.");
    expect(setupErrorMessage(Object.assign(new Error("API Error: 500"), { status: 500 }))).toBe(
      "Something went wrong on our end. Please try again.",
    );
    expect(
      setupErrorMessage({
        status: 500,
        data: { message: "database unavailable" },
      }),
    ).toBe("Something went wrong on our end. Please try again.");
    expect(setupErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "Couldn't save. Check your connection and try again.",
    );
    expect(setupErrorMessage(new Error("API Error: 409"))).not.toContain("API Error");
  });
});

describe("property profile requests", () => {
  const draft = {
    displayName: "Hotel Alpenrose",
    propertyType: "hotel",
    countryCode: "DE",
    city: "Munich",
    streetAddress: "Marienplatz 1",
    postalCode: "80331",
    latitude: 48.137,
    longitude: 11.575,
    timezone: "Europe/Berlin",
    contactEmail: "hello@alpenrose.example",
    phone: "+49 89 123456",
    whatsapp: "+49 170 1234567",
    localityPublic: false,
    logoFile: null,
    logoMediaObjectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    logoPublicUrl: "https://cdn.example.com/alpenrose-logo.webp",
  } as Parameters<typeof createProfileFromDraft>[0];

  it("creates public guest contacts and private location defaults", () => {
    const request = createProfileFromDraft(draft);

    expect(request.location).toMatchObject({
      localityPublic: false,
      geoPublic: false,
      mapDisplayMode: "hidden",
    });
    expect(request.contacts).toEqual([
      {
        channelType: "phone",
        value: "+49 89 123456",
        purpose: "general",
        isPublic: true,
      },
      {
        channelType: "whatsapp",
        value: "+49 170 1234567",
        purpose: "general",
        isPublic: true,
      },
      {
        channelType: "email",
        value: "hello@alpenrose.example",
        purpose: "general",
        isPublic: true,
      },
    ]);
  });

  it("updates guest-facing contacts without deleting unrelated contacts", () => {
    const request = profileUpdateFromDraft(draft, {
      propertyId: "property-1",
      profileRevision: 7,
      profile: {
        ...createProfileFromDraft(draft),
        contacts: [
          {
            channelType: "email",
            value: "old@alpenrose.example",
            purpose: "general",
            isPublic: true,
          },
          {
            channelType: "phone",
            value: "+49 89 000000",
            purpose: "general",
            isPublic: false,
          },
          {
            channelType: "instagram",
            value: "@alpenrose",
            purpose: "creator",
            isPublic: true,
          },
        ],
      },
    });

    expect(request).not.toBeNull();
    if (!request) throw new Error("Expected a profile update.");
    expect(request.expectedProfileRevision).toBe(7);
    expect(request.patch.displayName).toBeUndefined();
    expect(request.patch.propertyType).toBeUndefined();
    expect(request.patch.location).toBeUndefined();
    expect(request.patch.contacts).toContainEqual({
      channelType: "email",
      value: "hello@alpenrose.example",
      purpose: "general",
      isPublic: true,
    });
    expect(request.patch.contacts).not.toContainEqual(
      expect.objectContaining({ value: "old@alpenrose.example" }),
    );
    expect(request.patch.contacts).toContainEqual({
      channelType: "instagram",
      value: "@alpenrose",
      purpose: "creator",
      isPublic: true,
    });
  });

  it("leaves an existing published contact unchanged when the entered value matches", () => {
    const profile = createProfileFromDraft(draft);
    profile.contacts = profile.contacts.map((contact) => ({ ...contact, isPublic: true }));

    expect(
      profileUpdateFromDraft(draft, {
        propertyId: "property-1",
        profileRevision: 8,
        profile,
      }),
    ).toBeNull();
  });

  it("promotes matching legacy contacts and preserves the existing website", () => {
    const profile = createProfileFromDraft(draft);
    profile.contacts = [
      ...profile.contacts.map((contact) => ({ ...contact, isPublic: false })),
      {
        channelType: "website",
        value: "https://alpenrose.example",
        purpose: "general",
        isPublic: true,
      },
    ];

    const request = profileUpdateFromDraft(draft, {
      propertyId: "property-1",
      profileRevision: 9,
      profile,
    });

    expect(request?.patch.contacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channelType: "phone", isPublic: true }),
        expect.objectContaining({ channelType: "whatsapp", isPublic: true }),
        expect.objectContaining({ channelType: "email", isPublic: true }),
        expect.objectContaining({ channelType: "website", isPublic: true }),
      ]),
    );
  });

  it("removes every published WhatsApp contact when WhatsApp is left blank", () => {
    const profile = createProfileFromDraft(draft);
    profile.contacts.push(
      {
        channelType: "whatsapp",
        value: "+49 170 0000000",
        purpose: "guest",
        isPublic: true,
      },
      {
        channelType: "whatsapp",
        value: "+49 170 9999999",
        purpose: "operations",
        isPublic: false,
      },
    );

    const request = profileUpdateFromDraft(
      { ...draft, whatsapp: "" },
      {
        propertyId: "property-1",
        profileRevision: 10,
        profile,
      },
    );

    const whatsappContacts = request?.patch.contacts?.filter(
      (contact) => contact.channelType === "whatsapp",
    );
    expect(whatsappContacts).toEqual([
      expect.objectContaining({ purpose: "operations", isPublic: false }),
    ]);
  });

  it("skips an update when no shared identity field changed", () => {
    const profile = createProfileFromDraft(draft);

    expect(
      profileUpdateFromDraft(draft, {
        propertyId: "property-1",
        profileRevision: 3,
        profile,
      }),
    ).toBeNull();
  });

  it("includes only changed location fields in the patch", () => {
    const profile = createProfileFromDraft(draft);
    const request = profileUpdateFromDraft(
      { ...draft, city: "Berlin" },
      {
        propertyId: "property-1",
        profileRevision: 4,
        profile,
      },
    );

    expect(request).toEqual({
      expectedProfileRevision: 4,
      patch: { location: { city: "Berlin" } },
    });
  });

  it("persists explicit public-locality consent while forcing private geo fields", () => {
    expect(createProfileFromDraft({ ...draft, localityPublic: true }).location).toMatchObject({
      localityPublic: true,
      geoPublic: false,
      mapDisplayMode: "hidden",
    });

    const existing = createProfileFromDraft(draft);
    existing.location = {
      ...existing.location,
      localityPublic: false,
      geoPublic: true,
      mapDisplayMode: "exact",
    };
    expect(
      profileUpdateFromDraft(
        { ...draft, localityPublic: true },
        { propertyId: "property-1", profileRevision: 9, profile: existing },
      ),
    ).toEqual({
      expectedProfileRevision: 9,
      patch: {
        location: {
          localityPublic: true,
          geoPublic: false,
          mapDisplayMode: "hidden",
        },
      },
    });
  });
});

describe("mergeTrackSelectionAfterConflict", () => {
  it("preserves the owner’s intent while retaining tracks another session already added", () => {
    expect(mergeTrackSelectionAfterConflict(["hotel_operations"], ["creator_marketplace"])).toEqual(
      ["hotel_operations", "creator_marketplace"],
    );
  });

  it("keeps canonical order and removes duplicates", () => {
    expect(
      mergeTrackSelectionAfterConflict(
        ["creator_marketplace", "hotel_operations"],
        ["hotel_operations"],
      ),
    ).toEqual(["hotel_operations", "creator_marketplace"]);
  });
});

describe("inline setup task navigation", () => {
  it("lets an authorized user revisit completed work without reopening blocked work", () => {
    expect(
      isInlineSetupTaskEditable({
        taskId: "public_profile",
        track: "creator_marketplace",
        readiness: "complete",
        callerCapability: "allowed",
      }),
    ).toBe(true);
    expect(
      isInlineSetupTaskEditable({
        taskId: "public_profile",
        track: "creator_marketplace",
        readiness: "complete",
        callerCapability: "ask_owner",
      }),
    ).toBe(false);
    expect(
      isInlineSetupTaskEditable({
        taskId: "rooms_rates_availability",
        track: "hotel_operations",
        readiness: "blocked",
        callerCapability: "allowed",
      }),
    ).toBe(false);
    expect(
      isInlineSetupTaskEditable({
        taskId: "shared_identity",
        track: "shared",
        readiness: "complete",
        callerCapability: "allowed",
      }),
    ).toBe(true);
  });

  it("keeps future ready tasks locked until they become the recommended wizard step", () => {
    const creatorOffer = inlineTask(
      "creator_offer",
      "actionable",
      "allowed",
      "creator_marketplace",
    );
    const rooms = inlineTask(
      "rooms_rates_availability",
      "actionable",
      "allowed",
      "hotel_operations",
    );
    const completedProfile = inlineTask(
      "public_profile",
      "complete",
      "allowed",
      "creator_marketplace",
    );

    expect(isInlineSetupTaskSelectable(creatorOffer, "creator_offer")).toBe(true);
    expect(isInlineSetupTaskSelectable(rooms, "creator_offer")).toBe(false);
    expect(isInlineSetupTaskSelectable(completedProfile, "creator_offer")).toBe(true);
  });

  it("backs up to the nearest editable task and skips permission-blocked steps", () => {
    expect(
      previousEditableSetupTaskId(
        [
          inlineTask("shared_identity", "complete", "allowed", "shared"),
          inlineTask("public_profile", "blocked", "forbidden", "creator_marketplace"),
          inlineTask("creator_offer", "complete", "allowed", "creator_marketplace"),
          inlineTask("rooms_rates_availability", "actionable", "allowed", "hotel_operations"),
        ],
        "rooms_rates_availability",
      ),
    ).toBe("creator_offer");
    expect(
      previousEditableSetupTaskId(
        [
          inlineTask("shared_identity", "complete", "allowed", "shared"),
          inlineTask("public_profile", "blocked", "forbidden", "creator_marketplace"),
        ],
        "public_profile",
      ),
    ).toBe("shared_identity");
  });

  it("selects only the authoritative actionable recommendation after a save", () => {
    const status = {
      setupPlan: {
        recommendedTaskId: "creator_offer",
        tasks: [
          inlineTask("public_profile", "complete", "allowed", "creator_marketplace"),
          inlineTask("creator_offer", "actionable", "allowed", "creator_marketplace"),
        ],
      },
    } as Parameters<typeof recommendedInlineSetupTaskId>[0];

    expect(recommendedInlineSetupTaskId(status)).toBe("creator_offer");

    status.setupPlan!.tasks[1]!.readiness = "pending_sync";
    expect(recommendedInlineSetupTaskId(status)).toBeNull();
  });

  it("permits a save only while the task and plan revision are still current", () => {
    const status = inlineStatus("plan-1", "public_profile", [
      inlineTask("shared_identity", "complete", "allowed", "shared"),
      inlineTask("public_profile", "actionable", "allowed", "creator_marketplace"),
    ]);
    const expected = {
      propertyId: "property-1",
      taskId: "public_profile" as const,
      planRevision: "plan-1",
    };

    expect(isInlineSetupTaskSaveCurrent(status, expected)).toBe(true);
    expect(
      isInlineSetupTaskSaveCurrent(
        { ...status, setupPlan: { ...status.setupPlan!, planRevision: "plan-2" } },
        expected,
      ),
    ).toBe(false);
    expect(
      isInlineSetupTaskSaveCurrent(
        inlineStatus("plan-1", "creator_offer", status.setupPlan!.tasks),
        expected,
      ),
    ).toBe(false);
    const revisitedStatus = inlineStatus("plan-1", "creator_offer", [
      inlineTask("public_profile", "complete", "allowed", "creator_marketplace"),
      inlineTask("creator_offer", "actionable", "allowed", "creator_marketplace"),
    ]);
    expect(isInlineSetupTaskSaveCurrent(revisitedStatus, expected)).toBe(true);
    expect(INLINE_SETUP_STALE_SAVE_MESSAGE).toContain("refreshed the latest step");
  });

  it("navigates clean forms without prompting and asks before discarding dirty forms", () => {
    let confirmationCount = 0;
    const denyDiscard = () => {
      confirmationCount += 1;
      return false;
    };

    expect(canLeaveInlineSetupTask(false, denyDiscard)).toBe(true);
    expect(confirmationCount).toBe(0);
    expect(canLeaveInlineSetupTask(true, denyDiscard)).toBe(false);
    expect(confirmationCount).toBe(1);
    expect(canLeaveInlineSetupTask(true, () => true)).toBe(true);
  });

  it("blocks browser unload while the current step has unsaved changes", () => {
    let prevented = false;
    const event = {
      preventDefault: () => {
        prevented = true;
      },
      returnValue: "unchanged",
    };

    blockInlineSetupUnload(event);

    expect(prevented).toBe(true);
    expect(event.returnValue).toBe("");
  });
});

describe("locationResetForManualAddressEdit", () => {
  it("clears Google coordinates when the city changes", () => {
    expect(locationResetForManualAddressEdit("city")).toEqual({
      latitude: null,
      longitude: null,
    });
  });

  it("clears Google coordinates when the country changes", () => {
    expect(locationResetForManualAddressEdit("countryCode")).toEqual({
      latitude: null,
      longitude: null,
    });
  });

  it("clears Google coordinates when the street changes", () => {
    expect(locationResetForManualAddressEdit("streetAddress")).toEqual({
      latitude: null,
      longitude: null,
    });
  });
});

describe("canConfirmLocation", () => {
  const completeLocation = {
    streetAddress: "Marienplatz 1",
    postalCode: "80331",
    city: "Munich",
    countryCode: "DE",
    timezone: "Europe/Berlin",
  };

  it("keeps partial Google results editable", () => {
    expect(canConfirmLocation({ ...completeLocation, postalCode: "" })).toBe(false);
  });

  it("requires a time zone before confirming an address", () => {
    expect(canConfirmLocation({ ...completeLocation, timezone: "" })).toBe(false);
    expect(canConfirmLocation(completeLocation)).toBe(true);
  });

  it("requires a valid IANA time zone before confirming an address", () => {
    expect(canConfirmLocation({ ...completeLocation, timezone: "Europe/Not_A_Real_Place" })).toBe(
      false,
    );
    expect(canConfirmLocation({ ...completeLocation, timezone: "Etc/UTC" })).toBe(true);
  });
});

describe("validateProfileDraft", () => {
  it("requires one property-owned logo", () => {
    const draft = {
      displayName: "Hotel Alpenrose",
      propertyType: "hotel",
      countryCode: "DE",
      city: "Munich",
      streetAddress: "Marienplatz 1",
      postalCode: "80331",
      timezone: "Europe/Berlin",
      contactEmail: "owner@alpenrose.example",
      phone: "+49 89 123456",
      whatsapp: "",
      localityPublic: false,
      logoFile: null,
      logoMediaObjectId: null,
      logoPublicUrl: "",
    } as Parameters<typeof validateProfileDraft>[0];

    expect(validateProfileDraft(draft).logo).toEqual(["Hotel logo is required."]);
    expect(
      validateProfileDraft({
        ...draft,
        logoMediaObjectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }).logo,
    ).toBeUndefined();
  });

  it("rejects invalid time zones", () => {
    const draft = {
      displayName: "Hotel Alpenrose",
      propertyType: "hotel",
      countryCode: "DE",
      city: "Munich",
      streetAddress: "Marienplatz 1",
      postalCode: "80331",
      timezone: "Europe/Not_A_Real_Place",
      contactEmail: "owner@alpenrose.example",
      phone: "+49 89 123456",
      whatsapp: "",
    } as Parameters<typeof validateProfileDraft>[0];

    expect(validateProfileDraft(draft)["location.timezone"]).toEqual([
      "Enter a valid IANA time zone.",
    ]);
  });

  it("rejects arbitrary text and too-short phone numbers", () => {
    const draft = {
      displayName: "Hotel Alpenrose",
      propertyType: "hotel",
      countryCode: "DE",
      city: "Munich",
      streetAddress: "Marienplatz 1",
      postalCode: "80331",
      timezone: "Europe/Berlin",
      contactEmail: "owner@alpenrose.example",
      phone: "not a phone",
      whatsapp: "",
    } as Parameters<typeof validateProfileDraft>[0];

    expect(validateProfileDraft(draft).phone).toEqual(["Enter a valid phone number."]);
    expect(validateProfileDraft({ ...draft, phone: "+49 12" }).phone).toEqual([
      "Enter a valid phone number.",
    ]);
    expect(validateProfileDraft({ ...draft, phone: "+49 89 123456" }).phone).toBe(undefined);
    expect(validateProfileDraft({ ...draft, phone: "089 123456" }).phone).toEqual([
      "Enter a valid phone number.",
    ]);
    expect(validateProfileDraft({ ...draft, whatsapp: "not a phone" }).whatsapp).toEqual([
      "Enter a valid WhatsApp number.",
    ]);
  });
});

describe("phoneWithCountryCallingCode", () => {
  it("keeps the national number when changing country prefixes", () => {
    expect(phoneWithCountryCallingCode("+49 89 123456", "LK")).toBe("+94 89123456");
  });

  it("starts an empty phone with the selected prefix", () => {
    expect(phoneWithCountryCallingCode("", "DE")).toBe("+49 ");
  });

  it("does not keep an incomplete previous prefix when the country changes", () => {
    expect(phoneWithCountryCallingCode("+49 ", "LK", "DE")).toBe("+94 ");
  });

  it("normalizes a national number with the selected country", () => {
    expect(normalizedPhoneNumber("0771234567", "LK")).toBe("+94 77 123 4567");
  });
});

describe("hasMapCoordinates", () => {
  it("accepts finite latitude and longitude values within geographic bounds", () => {
    expect(hasMapCoordinates({ latitude: 48.1373932, longitude: 11.5754485 })).toBe(true);
    expect(hasMapCoordinates({ latitude: -90, longitude: -180 })).toBe(true);
    expect(hasMapCoordinates({ latitude: 90, longitude: 180 })).toBe(true);
    expect(hasMapCoordinates({ latitude: null, longitude: 11.5754485 })).toBe(false);
    expect(hasMapCoordinates({ latitude: Number.NaN, longitude: 11.5754485 })).toBe(false);
    expect(hasMapCoordinates({ latitude: -90.1, longitude: 0 })).toBe(false);
    expect(hasMapCoordinates({ latitude: 90.1, longitude: 0 })).toBe(false);
    expect(hasMapCoordinates({ latitude: 0, longitude: -180.1 })).toBe(false);
    expect(hasMapCoordinates({ latitude: 0, longitude: 180.1 })).toBe(false);
  });
});

function inlineTask(
  taskId: Parameters<typeof previousEditableSetupTaskId>[0][number]["taskId"],
  readiness: Parameters<typeof previousEditableSetupTaskId>[0][number]["readiness"],
  callerCapability: Parameters<typeof previousEditableSetupTaskId>[0][number]["callerCapability"],
  track: Parameters<typeof previousEditableSetupTaskId>[0][number]["track"],
): Parameters<typeof previousEditableSetupTaskId>[0][number] {
  return { taskId, readiness, callerCapability, track };
}

function inlineStatus(
  planRevision: string,
  recommendedTaskId: Parameters<typeof previousEditableSetupTaskId>[0][number]["taskId"] | null,
  tasks: Parameters<typeof previousEditableSetupTaskId>[0],
): Parameters<typeof isInlineSetupTaskSaveCurrent>[0] {
  return {
    setupPlan: {
      propertyId: "property-1",
      planRevision,
      recommendedTaskId,
      tasks: tasks.map((task) => ({
        ...task,
        propertyId: "property-1",
      })),
    },
  } as Parameters<typeof isInlineSetupTaskSaveCurrent>[0];
}
