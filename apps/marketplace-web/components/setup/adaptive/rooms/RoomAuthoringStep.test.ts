import { createElement, StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type {
  PropertySetupRouteReadModel,
  PropertySetupStepDraft,
  SavePropertySetupDraftReceipt,
} from "@vayada/domain-hotels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPhotoPlan: vi.fn(),
  loadWorkspace: vi.fn(),
  saveDraft: vi.fn(),
  ensureRoomTarget: vi.fn(),
  saveRoom: vi.fn(),
  removeRoom: vi.fn(),
  uploadRoomPhotos: vi.fn(),
}));

vi.mock("@/services/api/roomAuthoringClient", () => ({
  RoomAuthoringOwnerError: class RoomAuthoringOwnerError extends Error {},
  roomAuthoringApi: mocks,
}));

import { RoomAuthoringStep, type RoomAuthoringSessionStore } from "./RoomAuthoringStep";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";

describe("RoomAuthoringStep first-visit recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPhotoPlan.mockResolvedValue({
      plan: "commission",
      maxRoomPhotosPerType: 10,
    });
    mocks.loadWorkspace.mockResolvedValue([]);
    mocks.saveDraft.mockResolvedValue(draftReceipt());
    mocks.ensureRoomTarget.mockResolvedValue({
      roomTypeId: "66666666-6666-4666-8666-666666666666",
      roomFactsRevision: 1,
      facts: {},
    });
    mocks.saveRoom.mockResolvedValue({
      roomTypeId: "66666666-6666-4666-8666-666666666666",
      roomFactsRevision: 1,
      roomUnitsRevision: 1,
      roomMediaRevision: 1,
      roomAmenitiesRevision: 1,
      facts: { name: "Garden Suite" },
    });
    mocks.uploadRoomPhotos.mockResolvedValue([
      {
        mediaObjectId: "77777777-7777-4777-8777-777777777777",
        purpose: "pms.room_type.media",
        status: "private_ready",
        publicVariants: [],
      },
    ]);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    vi.stubGlobal("document", {
      activeElement: null,
      getElementById: vi.fn(() => null),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("saves draft:null first-visit edits with the exact current owner manifest", async () => {
    const store: RoomAuthoringSessionStore = {};
    const initial = routeWithRoomsDraft(null);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(RoomAuthoringStep, {
          ...context(initial),
          sessionStore: store,
        }),
      );
    });

    expect(JSON.stringify(renderer?.toJSON())).not.toContain("Setup data is still unavailable");
    expect(mocks.loadWorkspace).toHaveBeenCalledOnce();
    const nameInput = renderer!.root.find(
      (node) =>
        node.type === "input" &&
        typeof node.props.id === "string" &&
        node.props.id.endsWith("-name"),
    );
    const draftRoomId = String(nameInput.props.id).slice(0, -"-name".length);

    await act(async () => {
      nameInput.props.onChange({ target: { value: "Locally edited Garden Suite" } });
    });

    expect(store.rooms?.[0]?.name).toBe("Locally edited Garden Suite");
    await act(async () => {
      await store.beforeLeave?.();
    });
    expect(mocks.saveDraft).toHaveBeenCalledOnce();
    expect(mocks.ensureRoomTarget).not.toHaveBeenCalled();
    expect(mocks.uploadRoomPhotos).not.toHaveBeenCalled();
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({
        stepId: "rooms",
        expectedBaseRevisions: {
          "pms.room_types": "types:1",
          "pms.room_units": "units:1",
          "pms.room_media": "media:1",
        },
        payload: expect.objectContaining({
          "room.name": { [draftRoomId]: "Locally edited Garden Suite" },
        }),
      }),
    );
    expect(store.rooms?.[0]?.name).toBe("Locally edited Garden Suite");
    expect(store.dirty).toBe(false);

    renderer?.unmount();
  });

  it("retains the canonical room target when a downstream final-save assignment fails", async () => {
    const room = {
      ...completeRoomWithoutPhotos(),
      photos: [
        {
          mediaObjectId: "77777777-7777-4777-8777-777777777777",
          previewUrl: null,
          uploadState: "ready" as const,
          errorMessage: null,
        },
      ],
    };
    const store: RoomAuthoringSessionStore = {
      propertyId,
      rooms: [room],
      dirty: true,
    };
    mocks.ensureRoomTarget.mockResolvedValueOnce({
      roomTypeId: "88888888-8888-4888-8888-888888888888",
      roomFactsRevision: 4,
      facts: {},
    });
    mocks.saveRoom.mockRejectedValueOnce(new Error("Room media assignment is unavailable."));
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(RoomAuthoringStep, {
          ...context(routeWithRoomsDraft(emptyRoomsDraft())),
          sessionStore: store,
        }),
      );
    });
    const saveButton = renderer!.root.find(
      (node) =>
        node.type === "button" && node.children.some((child) => child === "Save and continue"),
    );
    await act(async () => {
      saveButton.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.saveDraft).toHaveBeenCalledOnce();
    expect(mocks.ensureRoomTarget).toHaveBeenCalledOnce();
    expect(mocks.saveRoom).toHaveBeenCalledWith({
      propertyId,
      room: expect.objectContaining({
        draftRoomId: room.draftRoomId,
        roomTypeId: "88888888-8888-4888-8888-888888888888",
        roomFactsRevision: 4,
      }),
    });
    expect(store.rooms?.[0]).toMatchObject({
      roomTypeId: "88888888-8888-4888-8888-888888888888",
      roomFactsRevision: 4,
      saved: false,
      dirty: false,
    });
    expect(JSON.stringify(renderer?.toJSON())).toContain("Room media assignment is unavailable.");

    renderer?.unmount();
  });

  it("does not let editing a saved room hide the current unfinished draft", async () => {
    const unfinished = { ...completeRoomWithoutPhotos(), name: "Unfinished Loft" };
    const saved = {
      ...completeRoomWithoutPhotos(),
      draftRoomId: "draft:99999999-9999-4999-8999-999999999999",
      roomTypeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      roomFactsRevision: 2,
      saved: true,
      dirty: false,
      name: "Saved Suite",
    };
    const store: RoomAuthoringSessionStore = {
      propertyId,
      rooms: [unfinished, saved],
      dirty: true,
    };
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(RoomAuthoringStep, {
          ...context(routeWithRoomsDraft(emptyRoomsDraft())),
          sessionStore: store,
        }),
      );
    });

    const editSaved = renderer!.root.find(
      (node) => node.type === "button" && node.children.some((child) => child === "Edit"),
    );
    expect(editSaved.props.disabled).toBe(true);
    expect(JSON.stringify(renderer?.toJSON())).toContain("Unfinished Loft");
    expect(store.rooms?.find(({ name }) => name === "Unfinished Loft")).toBeDefined();

    renderer?.unmount();
  });

  it("moves keyboard focus to the real bathroom group target after validation", async () => {
    const room = {
      ...completeRoomWithoutPhotos(),
      bathroomType: "" as const,
      photos: [
        {
          mediaObjectId: "77777777-7777-4777-8777-777777777777",
          previewUrl: null,
          uploadState: "ready" as const,
          errorMessage: null,
        },
      ],
    };
    const store: RoomAuthoringSessionStore = {
      propertyId,
      rooms: [room],
      dirty: true,
    };
    const focus = vi.fn();
    vi.mocked(document.getElementById).mockImplementation((id) =>
      id === `${room.draftRoomId}-bathroomType` ? ({ focus } as unknown as HTMLElement) : null,
    );
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(RoomAuthoringStep, {
          ...context(routeWithRoomsDraft(emptyRoomsDraft())),
          sessionStore: store,
        }),
      );
    });
    const saveButton = renderer!.root.find(
      (node) =>
        node.type === "button" && node.children.some((child) => child === "Save and continue"),
    );
    await act(async () => saveButton.props.onClick());

    expect(document.getElementById).toHaveBeenCalledWith(`${room.draftRoomId}-bathroomType`);
    expect(focus).toHaveBeenCalledOnce();
    renderer?.unmount();
  });

  it("activates a fresh room draft after safely removing the last saved room", async () => {
    const saved = {
      ...completeRoomWithoutPhotos(),
      roomTypeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      roomFactsRevision: 2,
      saved: true,
      dirty: false,
      photos: [
        {
          mediaObjectId: "77777777-7777-4777-8777-777777777777",
          previewUrl: null,
          uploadState: "ready" as const,
          errorMessage: null,
        },
      ],
    };
    const store: RoomAuthoringSessionStore = {
      propertyId,
      rooms: [saved],
      dirty: false,
    };
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(RoomAuthoringStep, {
          ...context(routeWithRoomsDraft(emptyRoomsDraft())),
          sessionStore: store,
        }),
      );
    });
    const edit = renderer!.root.find(
      (node) => node.type === "button" && node.children.some((child) => child === "Edit"),
    );
    await act(async () => edit.props.onClick());
    const openRemoval = renderer!.root.find(
      (node) =>
        node.type === "button" && node.children.some((child) => child === "Remove room type"),
    );
    await act(async () => openRemoval.props.onClick());
    const confirmRemoval = renderer!.root
      .findAll(
        (node) =>
          node.type === "button" && node.children.some((child) => child === "Remove room type"),
      )
      .at(-1)!;
    await act(async () => confirmRemoval.props.onClick());

    expect(mocks.removeRoom).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({ saved: true }),
    );
    expect(store.rooms).toHaveLength(1);
    expect(store.rooms?.[0]).toMatchObject({ roomTypeId: null, saved: false });
    expect(JSON.stringify(renderer?.toJSON())).toContain("New room type");
    renderer?.unmount();
  });

  it("durably saves the stable room draft before creating a canonical photo target", async () => {
    const room = completeRoomWithoutPhotos();
    const store: RoomAuthoringSessionStore = {
      propertyId,
      rooms: [room],
      dirty: true,
    };
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(RoomAuthoringStep, {
          ...context(routeWithRoomsDraft(emptyRoomsDraft())),
          sessionStore: store,
        }),
      );
    });

    const photoButton = renderer!.root.find(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (child) => typeof child === "string" && child.includes("Add or arrange photos"),
        ),
    );
    expect(photoButton.props.disabled).toBe(false);
    await act(async () => photoButton.props.onClick());
    const fileInput = renderer!.root.find(
      (node) => node.type === "input" && node.props.type === "file",
    );
    const file = new File([new Uint8Array([1, 2, 3])], "garden-suite.jpg", {
      type: "image/jpeg",
    });

    await act(async () => {
      fileInput.props.onChange({ target: { files: [file], value: "garden-suite.jpg" } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.saveDraft).toHaveBeenCalledOnce();
    expect(mocks.saveDraft.mock.calls[0]?.[1]).toMatchObject({
      payload: { "room.name": { [room.draftRoomId]: "Garden Suite" } },
    });
    expect(mocks.saveDraft.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureRoomTarget.mock.invocationCallOrder[0]!,
    );
    expect(mocks.ensureRoomTarget.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.uploadRoomPhotos.mock.invocationCallOrder[0]!,
    );
    expect(mocks.uploadRoomPhotos).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId,
        roomTypeId: "66666666-6666-4666-8666-666666666666",
        draftRoomId: room.draftRoomId,
      }),
    );
    expect(store.rooms?.[0]).toMatchObject({
      roomTypeId: "66666666-6666-4666-8666-666666666666",
      roomFactsRevision: 1,
      photos: [
        expect.objectContaining({
          mediaObjectId: "77777777-7777-4777-8777-777777777777",
          uploadState: "ready",
        }),
      ],
    });

    renderer?.unmount();
  });

  it("uses the returned commission plan cap and keeps photo removal available at the limit", async () => {
    mocks.loadPhotoPlan.mockResolvedValueOnce({
      plan: "commission",
      maxRoomPhotosPerType: 12,
    });
    const room = {
      ...completeRoomWithoutPhotos(),
      photos: Array.from({ length: 12 }, (_, index) => ({
        mediaObjectId: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
        previewUrl: `https://cdn.example.com/room-${index}.webp`,
        uploadState: "ready" as const,
        errorMessage: null,
      })),
    };
    const store: RoomAuthoringSessionStore = { propertyId, rooms: [room], dirty: true };
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(RoomAuthoringStep, {
          ...context(routeWithRoomsDraft(emptyRoomsDraft())),
          sessionStore: store,
        }),
      );
    });

    const rendered = JSON.stringify(renderer?.toJSON());
    expect(rendered).toContain("12/12 photos");
    expect(rendered).toContain(
      "You've reached the 12-photo limit. Upgrade to the paid plan for up to 15 photos per room.",
    );
    const arrange = renderer!.root.find(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (child) => typeof child === "string" && child.includes("Add or arrange photos"),
        ),
    );
    expect(arrange.props.disabled).toBe(false);
    await act(async () => arrange.props.onClick());
    expect(
      renderer!.root.findAll((node) => node.type === "input" && node.props.type === "file"),
    ).toHaveLength(0);
    expect(
      renderer!.root.findAll(
        (node) =>
          node.type === "button" &&
          typeof node.props["aria-label"] === "string" &&
          node.props["aria-label"].startsWith("Remove photo"),
      ).length,
    ).toBeGreaterThan(0);

    renderer?.unmount();
  });

  it("identity-cleans callbacks across Strict Mode room instances without clearing the replacement", async () => {
    const store: RoomAuthoringSessionStore = {};
    const route = routeWithRoomsDraft(emptyRoomsDraft());
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(RoomAuthoringStep, {
            key: "first-room-instance",
            ...context(route),
            sessionStore: store,
          }),
        ),
      );
    });
    const first = store.beforeLeave;
    expect(first).toBeTypeOf("function");

    await act(async () => {
      renderer?.update(
        createElement(
          StrictMode,
          null,
          createElement(RoomAuthoringStep, {
            key: "replacement-room-instance",
            ...context(route),
            sessionStore: store,
          }),
        ),
      );
    });
    const replacement = store.beforeLeave;
    expect(replacement).toBeTypeOf("function");
    expect(replacement).not.toBe(first);

    await act(async () => renderer?.unmount());
    expect(store.beforeLeave).toBeUndefined();
  });
});

function context(route: PropertySetupRouteReadModel) {
  const step = route.steps[0]!;
  return {
    route,
    step,
    interfaceLocale: "en" as const,
    saveAndContinue: vi.fn().mockResolvedValue(undefined),
    refreshRoute: vi.fn().mockResolvedValue(undefined),
    reportRevisionConflict: vi.fn(),
  };
}

function routeWithRoomsDraft(draft: PropertySetupStepDraft | null): PropertySetupRouteReadModel {
  return {
    contractVersion: "property-setup-route.v2",
    scope: { organizationId, propertyId },
    selectedTracks: ["hotel_operations"],
    trackRevision: 3,
    sessionId: draft ? "33333333-3333-4333-8333-333333333333" : null,
    sessionRevision: draft ? 7 : null,
    resumeStepId: "rooms",
    progress: { complete: 0, total: 1 },
    steps: [
      {
        stepId: "rooms",
        position: 1,
        state: draft ? "draft" : "not_started",
        sourceRevision: "rooms:0",
        currentBaseRevisions: {
          "pms.room_types": "types:1",
          "pms.room_units": "units:1",
          "pms.room_media": "media:1",
        },
        draft,
        blockers: [],
      },
    ],
  };
}

function emptyRoomsDraft(): Extract<PropertySetupStepDraft, { stepId: "rooms" }> {
  return {
    stepId: "rooms",
    payload: {},
    dirtyFields: [],
    baseRevisions: {
      "pms.room_types": "types:1",
      "pms.room_units": "units:1",
      "pms.room_media": "media:1",
    },
    piiClassification: "potential_incidental_pii",
    retentionExpiresAt: "2026-11-01T00:00:00.000Z",
    revision: 4,
    updatedAt: "2026-08-03T12:00:00.000Z",
  };
}

function draftReceipt(): SavePropertySetupDraftReceipt {
  return {
    contractVersion: "property-setup-draft.v1",
    sessionId: "33333333-3333-4333-8333-333333333333",
    stepId: "rooms",
    selectedTracks: ["hotel_operations"],
    trackRevision: 3,
    sessionRevision: 8,
    draftRevision: 5,
    retentionExpiresAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-08-03T12:05:00.000Z",
    replayed: false,
  };
}

function completeRoomWithoutPhotos() {
  return {
    draftRoomId: "draft:55555555-5555-4555-8555-555555555555",
    roomTypeId: null,
    roomFactsRevision: null,
    roomUnitsRevision: null,
    roomMediaRevision: null,
    roomAmenitiesRevision: null,
    name: "Garden Suite",
    unitCount: "3",
    maxGuests: "2",
    separateOccupancy: false,
    maxAdults: "",
    maxChildren: "",
    beds: [
      {
        id: "draft:55555555-5555-4555-8555-555555555555:bed:1",
        type: "king",
        quantity: "1",
      },
    ],
    bathroomType: "private" as const,
    description: "",
    category: "",
    bedrooms: "",
    bathrooms: "1",
    sizeSquareMetres: "",
    photos: [],
    amenityKeys: [],
    reviewedEmptyAmenities: true,
    saved: false,
    dirty: true,
  };
}
