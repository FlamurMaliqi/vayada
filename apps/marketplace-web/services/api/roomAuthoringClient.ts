import {
  PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
  parseAssignRoomTypeMediaResult,
  parseConfirmRoomTypeAmenitiesResult,
  parseCreateRoomTypeFactsResult,
  parseDraftRoomTypeBinding,
  parsePhysicalRoomUnitIdentity,
  parsePmsRoomAmenityKey,
  parseReconcilePhysicalRoomUnitsResult,
  parseSetPhysicalRoomOperationalLabelResult,
  parseRoomTypeCapacitySnapshot,
  parseRoomTypeFacts,
  parseRoomTypeFactsSnapshot,
  parseSafeDeleteRoomTypeResult,
  parseUpdateRoomTypeFactsResult,
  type RoomPublicationRoomSnapshot,
  type RoomTypeFacts,
  type RoomTypeFactsSnapshot,
  type PhysicalRoomUnitIdentity,
  type SetPhysicalRoomOperationalLabelResponse,
} from "@vayada/domain-pms";
import {
  PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
  parsePropertyMediaLibraryItem,
  type PropertyMediaLibraryItem,
  type SavePropertySetupDraftReceipt,
  type SavePropertySetupDraftRequest,
} from "@vayada/domain-hotels";

import type {
  CanonicalRoomAuthoringState,
  RoomAuthoringDraft,
} from "@/components/setup/adaptive/rooms/roomAuthoringState";
import { roomDraftToFacts } from "@/components/setup/adaptive/rooms/roomAuthoringState";
import { ApiErrorResponse, createVayadaApiClient } from "./client";
import { targetApiClient } from "./targetClient";

const PLATFORM_MEDIA_API_BASE_URL =
  process.env.NEXT_PUBLIC_PLATFORM_MEDIA_API_URL ??
  process.env.NEXT_PUBLIC_AUTH_API_URL ??
  "https://api.localhost";
const platformMediaClient = createVayadaApiClient(PLATFORM_MEDIA_API_BASE_URL);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RoomAuthoringHttpClient = {
  get<T>(endpoint: string, options?: RequestInit): Promise<T>;
  put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
  post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
  delete<T>(endpoint: string, options?: RequestInit): Promise<T>;
};

export type RoomMediaUploadHttpClient = {
  post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

export type SaveCanonicalRoomInput = {
  propertyId: string;
  room: RoomAuthoringDraft;
};

export type RoomAuthoringTarget = {
  roomTypeId: string;
  roomFactsRevision: number;
  facts: RoomTypeFacts;
};

export type RoomPhotoPlan = {
  plan: "commission" | "fixed";
  maxRoomPhotosPerType: number;
};

export type RoomAuthoringClient = {
  loadPhotoPlan(propertyId: string, options?: RequestInit): Promise<RoomPhotoPlan>;
  loadWorkspace(
    propertyId: string,
    draftRoomIds: readonly string[],
    options?: RequestInit,
  ): Promise<CanonicalRoomAuthoringState[]>;
  saveDraft(
    propertyId: string,
    request: SavePropertySetupDraftRequest,
  ): Promise<SavePropertySetupDraftReceipt>;
  ensureRoomTarget(input: SaveCanonicalRoomInput): Promise<RoomAuthoringTarget>;
  saveRoom(input: SaveCanonicalRoomInput): Promise<CanonicalRoomAuthoringState>;
  removeRoom(propertyId: string, room: RoomAuthoringDraft): Promise<void>;
  uploadRoomPhotos(input: {
    propertyId: string;
    roomTypeId: string;
    draftRoomId: string;
    files: readonly File[];
  }): Promise<PropertyMediaLibraryItem[]>;
};

export class RoomAuthoringOwnerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: unknown,
    readonly requiresRefresh: boolean,
  ) {
    super(message);
    this.name = "RoomAuthoringOwnerError";
  }
}

export function createRoomAuthoringClient(
  http: RoomAuthoringHttpClient,
  mediaHttp: RoomMediaUploadHttpClient,
  uploadFetch: typeof fetch = fetch,
): RoomAuthoringClient {
  const loadPhotoPlan = async (
    propertyId: string,
    options?: RequestInit,
  ): Promise<RoomPhotoPlan> => {
    const value = await http.get<unknown>(
      `/api/pms/properties/${encoded(propertyId)}/plan-limits`,
      options,
    );
    const parsed = parseRoomPhotoPlan(value, propertyId);
    if (!parsed) throw invalidOwnerContract("property plan limits");
    return parsed;
  };

  const readPublication = async (
    propertyId: string,
    options?: RequestInit,
  ): Promise<ParsedRoomPublication> => {
    const value = await http.get<unknown>(
      `/api/pms/properties/${encoded(propertyId)}/room-publication-snapshot`,
      options,
    );
    const parsed = parseRoomPublication(value);
    if (!parsed || parsed.propertyId !== propertyId.toLowerCase()) {
      throw invalidOwnerContract("room publication");
    }
    return parsed;
  };

  const loadWorkspace = async (
    propertyId: string,
    draftRoomIds: readonly string[],
    options?: RequestInit,
  ): Promise<CanonicalRoomAuthoringState[]> => {
    const [listValue, publication] = await Promise.all([
      http.get<unknown>(setupRoomPath(propertyId, "room-types"), options),
      readPublication(propertyId, options),
    ]);
    const facts = parseRoomTypeList(listValue, propertyId);
    if (!facts) throw invalidOwnerContract("room facts list");

    const bindings = await Promise.all(
      draftRoomIds.map(async (draftRoomId) => {
        try {
          const value = await http.get<unknown>(
            setupRoomPath(propertyId, `room-type-bindings/${encoded(draftRoomId)}`),
            options,
          );
          const binding = parseDraftRoomTypeBinding(value);
          if (
            !binding ||
            binding.propertyId !== propertyId.toLowerCase() ||
            String(binding.draftRoomId) !== draftRoomId
          ) {
            throw invalidOwnerContract("draft room binding");
          }
          return binding;
        } catch (error) {
          if (error instanceof ApiErrorResponse && error.status === 404) return null;
          throw error;
        }
      }),
    );
    const draftIdByRoomType = new Map(
      bindings.flatMap((binding) =>
        binding ? [[binding.roomTypeId, String(binding.draftRoomId)] as const] : [],
      ),
    );
    const publicationByRoomType = new Map(publication.rooms.map((room) => [room.roomTypeId, room]));

    return Promise.all(
      facts
        .filter(({ lifecycle }) => lifecycle === "active")
        .map(async (snapshot) => {
          const capacityValue = await http.get<unknown>(
            setupRoomPath(propertyId, `room-types/${encoded(snapshot.roomTypeId)}/capacity`),
            options,
          );
          const capacity = parseRoomTypeCapacitySnapshot(capacityValue);
          const published = publicationByRoomType.get(snapshot.roomTypeId);
          if (
            !capacity ||
            capacity.propertyId !== propertyId.toLowerCase() ||
            capacity.roomTypeId !== snapshot.roomTypeId ||
            !published ||
            published.sourceRevisions.roomFactsRevision !== snapshot.roomFactsRevision ||
            published.sourceRevisions.roomUnitsRevision !== capacity.roomUnitsRevision
          ) {
            throw invalidOwnerContract("room revisions");
          }
          return {
            draftRoomId:
              draftIdByRoomType.get(snapshot.roomTypeId) ?? `room:${snapshot.roomTypeId}`,
            roomTypeId: snapshot.roomTypeId,
            roomFactsRevision: snapshot.roomFactsRevision,
            roomUnitsRevision: capacity.roomUnitsRevision,
            roomMediaRevision: published.sourceRevisions.roomMediaRevision,
            roomAmenitiesRevision: published.sourceRevisions.roomAmenitiesRevision,
            facts: snapshot.facts,
            activeUnitCount: capacity.activeUnitCount,
            photos: published.media.map(({ mediaObjectId, publicVariants }) => ({
              mediaObjectId,
              publicUrl:
                publicVariants.find(({ variantName }) => variantName === "thumbnail")?.publicUrl ??
                publicVariants[0]?.publicUrl ??
                null,
            })),
            amenityKeys: published.amenities ?? [],
            amenitiesReviewed: published.amenities !== null,
          } satisfies CanonicalRoomAuthoringState;
        }),
    );
  };

  const saveDraft = async (
    propertyId: string,
    request: SavePropertySetupDraftRequest,
  ): Promise<SavePropertySetupDraftReceipt> => {
    if (request.stepId !== "rooms")
      throw new TypeError("Room authoring can save only rooms drafts.");
    const idempotencyKey = await commandKey("rooms-draft", propertyId, request);
    const value = await http.put<unknown>(
      `/api/hotel-setup/properties/${encoded(propertyId)}/setup-drafts/rooms`,
      request,
      { headers: { "Idempotency-Key": idempotencyKey } },
    );
    const receipt = parseDraftReceipt(value, propertyId, request);
    if (!receipt) throw invalidOwnerContract("rooms draft receipt");
    return receipt;
  };

  const ensureRoomTarget = async ({
    propertyId,
    room,
  }: SaveCanonicalRoomInput): Promise<RoomAuthoringTarget> => {
    const snapshot = await saveFacts(http, propertyId, room, roomDraftToFacts(room));
    return {
      roomTypeId: snapshot.roomTypeId,
      roomFactsRevision: snapshot.roomFactsRevision,
      facts: snapshot.facts,
    };
  };

  const saveRoom = async ({
    propertyId,
    room,
  }: SaveCanonicalRoomInput): Promise<CanonicalRoomAuthoringState> => {
    const facts = roomDraftToFacts(room);
    const roomType = await saveFacts(http, propertyId, room, facts);
    const capacityValue = await http.get<unknown>(
      setupRoomPath(propertyId, `room-types/${encoded(roomType.roomTypeId)}/capacity`),
      { cache: "no-store" },
    );
    const capacity = parseRoomTypeCapacitySnapshot(capacityValue);
    if (
      !capacity ||
      capacity.propertyId !== propertyId.toLowerCase() ||
      capacity.roomTypeId !== roomType.roomTypeId
    ) {
      throw invalidOwnerContract("room capacity");
    }

    const targetCount = Number(room.unitCount);
    let expectedUnitsRevision = capacity.roomUnitsRevision;
    if (capacity.activeUnitCount !== targetCount) {
      const body = {
        expectedRevision: capacity.roomUnitsRevision,
        targetActiveUnitCount: targetCount,
      };
      const response = await domainCommand(
        () =>
          http.put<unknown>(
            setupRoomPath(
              propertyId,
              `room-types/${encoded(roomType.roomTypeId)}/physical-units/reconcile`,
            ),
            body,
            {
              headers: {
                "Idempotency-Key": commandKeySync("room-units", propertyId, room.draftRoomId, body),
              },
            },
          ),
        parseReconcilePhysicalRoomUnitsResult,
        "physical room units",
      );
      if (
        response.capacity.propertyId !== propertyId.toLowerCase() ||
        response.capacity.roomTypeId !== roomType.roomTypeId ||
        response.capacity.roomUnitsRevision !== capacity.roomUnitsRevision + 1 ||
        response.capacity.activeUnitCount !== targetCount
      ) {
        throw invalidOwnerContract("physical room units");
      }
      expectedUnitsRevision = response.capacity.roomUnitsRevision;
    }
    expectedUnitsRevision = await verifyOperationalLabels(
      http,
      propertyId,
      roomType.roomTypeId,
      facts.name,
      expectedUnitsRevision,
    );

    let publication = await readPublication(propertyId, { cache: "no-store" });
    let published = publication.rooms.find(({ roomTypeId }) => roomTypeId === roomType.roomTypeId);
    if (
      !published ||
      published.sourceRevisions.roomFactsRevision !== roomType.roomFactsRevision ||
      published.sourceRevisions.roomUnitsRevision !== expectedUnitsRevision
    ) {
      throw invalidOwnerContract("new room publication");
    }

    const desiredMedia = room.photos
      .filter(({ uploadState }) => uploadState === "ready")
      .map(({ mediaObjectId }, sortOrder) => ({
        mediaObjectId,
        altText: `${facts.name} photo ${sortOrder + 1}`,
        sortOrder,
      }));
    if (
      !sameStrings(
        published.media.map(({ mediaObjectId }) => mediaObjectId),
        desiredMedia.map(({ mediaObjectId }) => mediaObjectId),
      )
    ) {
      const body = {
        expectedRoomMediaRevision: published.sourceRevisions.roomMediaRevision,
        assignments: desiredMedia,
      };
      const response = await domainCommand(
        () =>
          http.put<unknown>(
            `/api/pms/properties/${encoded(propertyId)}/room-types/${encoded(roomType.roomTypeId)}/media`,
            body,
            {
              headers: {
                "Idempotency-Key": commandKeySync("room-media", propertyId, room.draftRoomId, body),
              },
            },
          ),
        parseAssignRoomTypeMediaResult,
        "room media",
      );
      if (
        response.propertyId !== propertyId.toLowerCase() ||
        response.roomTypeId !== roomType.roomTypeId ||
        response.roomMediaRevision !== published.sourceRevisions.roomMediaRevision + 1 ||
        !sameStrings(
          response.assignments.map(({ mediaObjectId }) => mediaObjectId),
          desiredMedia.map(({ mediaObjectId }) => mediaObjectId),
        )
      ) {
        throw invalidOwnerContract("room media");
      }
    }

    const desiredAmenities = Array.from(new Set(room.amenityKeys)).sort();
    if (published.amenities === null || !sameStrings(published.amenities, desiredAmenities)) {
      const body = {
        expectedRoomAmenitiesRevision: published.sourceRevisions.roomAmenitiesRevision,
        amenities: desiredAmenities,
      };
      const response = await domainCommand(
        () =>
          http.put<unknown>(
            `/api/pms/properties/${encoded(propertyId)}/room-types/${encoded(roomType.roomTypeId)}/amenities`,
            body,
            {
              headers: {
                "Idempotency-Key": commandKeySync(
                  "room-amenities",
                  propertyId,
                  room.draftRoomId,
                  body,
                ),
              },
            },
          ),
        parseConfirmRoomTypeAmenitiesResult,
        "room amenities",
      );
      if (
        response.roomAmenities.propertyId !== propertyId.toLowerCase() ||
        response.roomAmenities.roomTypeId !== roomType.roomTypeId ||
        response.roomAmenities.roomAmenitiesRevision !==
          published.sourceRevisions.roomAmenitiesRevision + 1 ||
        !sameStrings(response.roomAmenities.amenities, desiredAmenities)
      ) {
        throw invalidOwnerContract("room amenities");
      }
    }

    publication = await readPublication(propertyId, { cache: "no-store" });
    published = publication.rooms.find(({ roomTypeId }) => roomTypeId === roomType.roomTypeId);
    const refreshedCapacityValue = await http.get<unknown>(
      setupRoomPath(propertyId, `room-types/${encoded(roomType.roomTypeId)}/capacity`),
      { cache: "no-store" },
    );
    const refreshedCapacity = parseRoomTypeCapacitySnapshot(refreshedCapacityValue);
    if (
      !published ||
      !refreshedCapacity ||
      refreshedCapacity.propertyId !== propertyId.toLowerCase() ||
      refreshedCapacity.roomTypeId !== roomType.roomTypeId ||
      refreshedCapacity.activeUnitCount !== targetCount ||
      published.sourceRevisions.roomFactsRevision !== roomType.roomFactsRevision ||
      published.sourceRevisions.roomUnitsRevision !== refreshedCapacity.roomUnitsRevision ||
      !sameStrings(
        published.media.map(({ mediaObjectId }) => mediaObjectId),
        desiredMedia.map(({ mediaObjectId }) => mediaObjectId),
      ) ||
      published.amenities === null ||
      !sameStrings(published.amenities, desiredAmenities)
    ) {
      throw invalidOwnerContract("saved room");
    }
    return {
      draftRoomId: room.draftRoomId,
      roomTypeId: roomType.roomTypeId,
      roomFactsRevision: roomType.roomFactsRevision,
      roomUnitsRevision: refreshedCapacity.roomUnitsRevision,
      roomMediaRevision: published.sourceRevisions.roomMediaRevision,
      roomAmenitiesRevision: published.sourceRevisions.roomAmenitiesRevision,
      facts: roomType.facts,
      activeUnitCount: refreshedCapacity.activeUnitCount,
      photos: published.media.map(({ mediaObjectId, publicVariants }) => ({
        mediaObjectId,
        publicUrl:
          publicVariants.find(({ variantName }) => variantName === "thumbnail")?.publicUrl ??
          publicVariants[0]?.publicUrl ??
          null,
      })),
      amenityKeys: published.amenities ?? [],
      amenitiesReviewed: published.amenities !== null,
    };
  };

  const removeRoom = async (propertyId: string, room: RoomAuthoringDraft): Promise<void> => {
    if (!room.roomTypeId || room.roomFactsRevision === null) return;
    const body = { expectedRevision: room.roomFactsRevision };
    const response = await domainCommand(
      () =>
        http.delete<unknown>(setupRoomPath(propertyId, `room-types/${encoded(room.roomTypeId!)}`), {
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": commandKeySync("room-remove", propertyId, room.draftRoomId, body),
          },
          body: JSON.stringify(body),
        }),
      parseSafeDeleteRoomTypeResult,
      "room removal",
    );
    if (
      response.propertyId !== propertyId.toLowerCase() ||
      response.roomTypeId !== room.roomTypeId.toLowerCase() ||
      response.deletedRevision !== room.roomFactsRevision + 1
    ) {
      throw invalidOwnerContract("room removal");
    }
  };

  const uploadRoomPhotos = async ({
    propertyId,
    roomTypeId,
    draftRoomId,
    files,
  }: {
    propertyId: string;
    roomTypeId: string;
    draftRoomId: string;
    files: readonly File[];
  }): Promise<PropertyMediaLibraryItem[]> => {
    if (files.length === 0) return [];
    const request = {
      idempotencyKey: await commandKey("room-photo-upload", propertyId, {
        draftRoomId,
        files: await Promise.all(
          files.map(async (file) => ({
            name: file.name,
            type: uploadContentType(file),
            size: file.size,
            digest: await sha256Hex(await file.arrayBuffer()),
          })),
        ),
      }),
      purpose: "pms.room_type.media",
      visibility: "public",
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: propertyId,
        propertyId,
        targetResourceId: roomTypeId,
      },
      files: files.map((file, index) => ({
        clientFileId: `file_${index + 1}`,
        filename: file.name || `room-photo-${index + 1}.jpg`,
        contentType: uploadContentType(file),
        sizeBytes: file.size,
      })),
    };
    const createdValue = await mediaHttp.post<unknown>("/api/media/upload-sessions", request);
    const created = parseUploadSession(createdValue, files.length);
    if (!created) throw invalidOwnerContract("room media upload session");
    if (created.status === "completed") {
      if (!created.mediaObjects) throw invalidOwnerContract("completed room media upload");
      return created.mediaObjects;
    }

    await Promise.all(
      created.targets.map(async (target, index) => {
        const file = files[index];
        if (!file) throw invalidOwnerContract("room media upload target");
        if (target.uploadUrl.startsWith("https://uploads.vayada.localhost/")) return;
        const response = await uploadFetch(target.uploadUrl, {
          method: "PUT",
          headers: target.headers,
          body: file,
        });
        if (!response.ok) {
          throw new ApiErrorResponse(response.status, {
            detail: `Photo upload failed for ${file.name || target.clientFileId}.`,
          });
        }
      }),
    );

    const finalizedValue = await mediaHttp.post<unknown>(
      `/api/media/upload-sessions/${encoded(created.sessionId)}/finalize`,
      {
        files: created.targets.map((target, index) => ({
          uploadTargetId: target.uploadTargetId,
          contentType: uploadContentType(files[index]!),
          sizeBytes: files[index]!.size,
        })),
      },
    );
    const finalized = parseFinalizedMedia(finalizedValue, files.length);
    if (!finalized) throw invalidOwnerContract("finalized room media");
    return finalized;
  };

  return {
    loadPhotoPlan,
    loadWorkspace,
    saveDraft,
    ensureRoomTarget,
    saveRoom,
    removeRoom,
    uploadRoomPhotos,
  };
}

export const roomAuthoringApi = createRoomAuthoringClient(targetApiClient, platformMediaClient);

function parseRoomPhotoPlan(value: unknown, propertyId: string): RoomPhotoPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (
    response["contractVersion"] !== "pms-operations.v1" ||
    response["propertyId"] !== propertyId.toLowerCase()
  ) {
    return null;
  }
  const rawPlan = response["propertyPlan"];
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) return null;
  const plan = rawPlan as Record<string, unknown>;
  const limits = plan["limits"];
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) return null;
  const maxRoomPhotosPerType = (limits as Record<string, unknown>)["maxRoomPhotosPerType"];
  if (
    (plan["plan"] !== "commission" && plan["plan"] !== "fixed") ||
    plan["propertyId"] !== propertyId.toLowerCase() ||
    !Number.isSafeInteger(maxRoomPhotosPerType) ||
    (maxRoomPhotosPerType as number) < 1
  ) {
    return null;
  }
  return { plan: plan["plan"], maxRoomPhotosPerType: maxRoomPhotosPerType as number };
}

async function saveFacts(
  http: RoomAuthoringHttpClient,
  propertyId: string,
  room: RoomAuthoringDraft,
  facts: RoomTypeFacts,
): Promise<RoomTypeFactsSnapshot> {
  if (!room.roomTypeId) {
    const body = { draftRoomId: room.draftRoomId, expectedRevision: 0, facts };
    try {
      const response = await domainCommand(
        () =>
          http.post<unknown>(setupRoomPath(propertyId, "room-types"), body, {
            headers: { "Idempotency-Key": createRoomCommandKey(propertyId, room.draftRoomId) },
          }),
        parseCreateRoomTypeFactsResult,
        "room facts",
      );
      if (
        response.roomType.propertyId !== propertyId.toLowerCase() ||
        response.draftRoomBinding.propertyId !== propertyId.toLowerCase() ||
        String(response.draftRoomBinding.draftRoomId) !== room.draftRoomId ||
        response.draftRoomBinding.roomTypeId !== response.roomType.roomTypeId ||
        JSON.stringify(response.roomType.facts) !== JSON.stringify(facts)
      ) {
        throw invalidOwnerContract("room facts");
      }
      return response.roomType;
    } catch (error) {
      if (
        !(error instanceof RoomAuthoringOwnerError) ||
        (error.code !== "draft_room_binding_conflict" && error.code !== "idempotency_key_conflict")
      ) {
        throw error;
      }
      const bound = await readBoundRoomFacts(http, propertyId, room.draftRoomId);
      if (JSON.stringify(bound.facts) === JSON.stringify(facts)) return bound;
      return saveFacts(
        http,
        propertyId,
        { ...room, roomTypeId: bound.roomTypeId, roomFactsRevision: bound.roomFactsRevision },
        facts,
      );
    }
  }

  if (room.roomFactsRevision === null) throw invalidOwnerContract("room facts revision");
  const currentValue = await http.get<unknown>(
    setupRoomPath(propertyId, `room-types/${encoded(room.roomTypeId)}`),
    { cache: "no-store" },
  );
  const current = parseRoomTypeFactsSnapshot(currentValue);
  if (
    !current ||
    current.propertyId !== propertyId.toLowerCase() ||
    current.roomTypeId !== room.roomTypeId.toLowerCase()
  ) {
    throw invalidOwnerContract("room facts");
  }
  if (current.lifecycle !== "active") {
    throw ownerError("room_facts_revision_conflict", {
      code: "room_facts_revision_conflict",
      currentRevision: current.roomFactsRevision,
      lifecycle: current.lifecycle,
    });
  }
  if (JSON.stringify(current.facts) === JSON.stringify(facts)) return current;
  if (current.roomFactsRevision !== room.roomFactsRevision) {
    throw ownerError("room_facts_revision_conflict", {
      code: "room_facts_revision_conflict",
      currentRevision: current.roomFactsRevision,
    });
  }

  const body = { expectedRevision: current.roomFactsRevision, facts };
  try {
    const response = await domainCommand(
      () =>
        http.put<unknown>(
          setupRoomPath(propertyId, `room-types/${encoded(room.roomTypeId!)}`),
          body,
          {
            headers: {
              "Idempotency-Key": commandKeySync("room-update", propertyId, room.draftRoomId, body),
            },
          },
        ),
      parseUpdateRoomTypeFactsResult,
      "room facts",
    );
    if (
      response.roomType.propertyId !== propertyId.toLowerCase() ||
      response.roomType.roomTypeId !== room.roomTypeId.toLowerCase() ||
      response.roomType.roomFactsRevision !== current.roomFactsRevision + 1 ||
      JSON.stringify(response.roomType.facts) !== JSON.stringify(facts)
    ) {
      throw invalidOwnerContract("room facts");
    }
    return response.roomType;
  } catch (error) {
    if (
      !(error instanceof RoomAuthoringOwnerError) ||
      error.code !== "room_facts_revision_conflict"
    ) {
      throw error;
    }
    const refreshedValue = await http.get<unknown>(
      setupRoomPath(propertyId, `room-types/${encoded(room.roomTypeId)}`),
      { cache: "no-store" },
    );
    const refreshed = parseRoomTypeFactsSnapshot(refreshedValue);
    if (
      !refreshed ||
      refreshed.propertyId !== propertyId.toLowerCase() ||
      refreshed.roomTypeId !== room.roomTypeId.toLowerCase() ||
      refreshed.lifecycle !== "active" ||
      JSON.stringify(refreshed.facts) !== JSON.stringify(facts)
    ) {
      throw error;
    }
    return refreshed;
  }
}

async function readBoundRoomFacts(
  http: RoomAuthoringHttpClient,
  propertyId: string,
  draftRoomId: string,
): Promise<RoomTypeFactsSnapshot> {
  const bindingValue = await http.get<unknown>(
    setupRoomPath(propertyId, `room-type-bindings/${encoded(draftRoomId)}`),
    { cache: "no-store" },
  );
  const binding = parseDraftRoomTypeBinding(bindingValue);
  if (
    !binding ||
    binding.propertyId !== propertyId.toLowerCase() ||
    String(binding.draftRoomId) !== draftRoomId
  ) {
    throw invalidOwnerContract("draft room binding");
  }
  const factsValue = await http.get<unknown>(
    setupRoomPath(propertyId, `room-types/${encoded(binding.roomTypeId)}`),
    { cache: "no-store" },
  );
  const snapshot = parseRoomTypeFactsSnapshot(factsValue);
  if (
    !snapshot ||
    snapshot.propertyId !== propertyId.toLowerCase() ||
    snapshot.roomTypeId !== binding.roomTypeId
  ) {
    throw invalidOwnerContract("room facts");
  }
  if (snapshot.lifecycle !== "active") {
    throw ownerError("room_facts_revision_conflict", {
      code: "room_facts_revision_conflict",
      currentRevision: snapshot.roomFactsRevision,
      lifecycle: snapshot.lifecycle,
    });
  }
  return snapshot;
}

type ParsedDomainResult =
  | { readonly ok: true; readonly response: unknown }
  | { readonly ok: false; readonly error: { readonly code: string } };

type ParsedDomainResponse<TResult extends ParsedDomainResult> = Extract<
  TResult,
  { readonly ok: true }
>["response"];

async function verifyOperationalLabels(
  http: RoomAuthoringHttpClient,
  propertyId: string,
  roomTypeId: string,
  roomTypeName: string,
  initialRevision: number,
): Promise<number> {
  const value = await http.get<unknown>(
    setupRoomPath(propertyId, `room-types/${encoded(roomTypeId)}/units`),
    { cache: "no-store" },
  );
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw invalidOwnerContract("physical room identities");
  }
  const units = value.items.map(parsePhysicalRoomUnitIdentity);
  if (
    units.some(
      (unit) =>
        !unit || unit.propertyId !== propertyId.toLowerCase() || unit.roomTypeId !== roomTypeId,
    )
  ) {
    throw invalidOwnerContract("physical room identities");
  }
  const activeUnits = (units as PhysicalRoomUnitIdentity[]).filter(
    ({ lifecycle }) => lifecycle === "active",
  );
  const usedLabels = new Set(
    (units as PhysicalRoomUnitIdentity[]).flatMap(({ operationalLabel }) =>
      operationalLabel ? [operationalLabel.toLowerCase()] : [],
    ),
  );
  let expectedRevision = initialRevision;
  for (let index = 0; index < activeUnits.length; index += 1) {
    const unit = activeUnits[index]!;
    if (unit.operationalLabelStatus === "verified") continue;
    let operationalLabel =
      unit.operationalLabel ?? generatedRoomLabel(roomTypeName, index + 1, usedLabels);
    let response: SetPhysicalRoomOperationalLabelResponse;
    while (true) {
      const body = { expectedRevision, operationalLabel };
      try {
        response = await domainCommand(
          () =>
            http.put<unknown>(
              `/api/pms/properties/${encoded(propertyId)}/room-types/${encoded(roomTypeId)}/physical-units/${encoded(unit.roomUnitId)}/operational-label`,
              body,
              {
                headers: {
                  "Idempotency-Key": commandKeySync(
                    "room-label",
                    propertyId,
                    unit.roomUnitId,
                    body,
                  ),
                },
              },
            ),
          parseSetPhysicalRoomOperationalLabelResult,
          "physical room label",
        );
        break;
      } catch (error) {
        if (
          unit.operationalLabel !== null ||
          !(error instanceof RoomAuthoringOwnerError) ||
          error.code !== "operational_label_conflict"
        ) {
          throw error;
        }
        usedLabels.add(operationalLabel.toLowerCase());
        operationalLabel = generatedRoomLabel(roomTypeName, index + 1, usedLabels);
      }
    }
    if (
      response.roomUnitId !== unit.roomUnitId ||
      response.operationalLabel !== operationalLabel ||
      response.roomUnitsRevision !== expectedRevision + 1
    ) {
      throw invalidOwnerContract("physical room label");
    }
    usedLabels.add(operationalLabel.toLowerCase());
    expectedRevision = response.roomUnitsRevision;
  }
  return expectedRevision;
}

function generatedRoomLabel(
  roomTypeName: string,
  initialPosition: number,
  usedLabels: ReadonlySet<string>,
): string {
  for (let position = initialPosition; ; position += 1) {
    const suffix = ` ${position}`;
    const candidate = `${roomTypeName.trim().slice(0, 200 - suffix.length)}${suffix}`;
    if (!usedLabels.has(candidate.toLowerCase())) return candidate;
  }
}

async function domainCommand<TResult extends ParsedDomainResult>(
  send: () => Promise<unknown>,
  parse: (value: unknown) => TResult | null,
  label: string,
): Promise<ParsedDomainResponse<TResult>> {
  try {
    const value = await send();
    const result = parse({ ok: true, response: value });
    if (!result?.ok) throw invalidOwnerContract(label);
    return result.response as ParsedDomainResponse<TResult>;
  } catch (error) {
    if (!(error instanceof ApiErrorResponse)) throw error;
    const result = parse({ ok: false, error: error.data });
    if (!result || result.ok) throw error;
    throw ownerError(result.error.code, result.error);
  }
}

function ownerError(code: string, details: unknown): RoomAuthoringOwnerError {
  const messages: Record<string, string> = {
    room_type_name_conflict: "Another room type already uses this name.",
    room_facts_revision_conflict: "This room changed in another session. Refresh before saving.",
    room_units_revision_conflict:
      "This room count changed in another session. Refresh before saving.",
    physical_unit_reconcile_blocked:
      "Some rooms are already protected by PMS activity. Keep the current count or manage them in PMS.",
    operational_label_conflict:
      "A generated room label is already in use. Rename the conflicting room in PMS and save again.",
    room_media_revision_conflict:
      "This room's photos changed in another session. Refresh before saving.",
    room_amenities_revision_conflict:
      "This room's amenities changed in another session. Refresh before saving.",
    room_type_delete_blocked:
      "This room type has operational references and cannot be removed during setup.",
    unsupported_room_fact_keys: "One of the selected room facts is no longer supported.",
    unsupported_room_amenity_keys: "One of the selected room amenities is no longer supported.",
    media_not_ready: "One or more photos are still processing. Try saving again shortly.",
  };
  const requiresRefresh = code.includes("revision_conflict") || code === "setup_scope_unavailable";
  return new RoomAuthoringOwnerError(
    messages[code] ?? "This room could not be saved. Try again.",
    code,
    details,
    requiresRefresh,
  );
}

function parseRoomTypeList(value: unknown, propertyId: string): RoomTypeFactsSnapshot[] | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.propertyId !== propertyId.toLowerCase()
  ) {
    return null;
  }
  const items = value.items.map(parseRoomTypeFactsSnapshot);
  return items.some((item) => !item || item.propertyId !== propertyId.toLowerCase())
    ? null
    : (items as RoomTypeFactsSnapshot[]);
}

type ParsedRoomPublication = {
  propertyId: string;
  rooms: Array<{
    roomTypeId: string;
    facts: RoomTypeFacts;
    activeUnitCount: number;
    media: RoomPublicationRoomSnapshot["media"];
    amenities: string[] | null;
    sourceRevisions: RoomPublicationRoomSnapshot["sourceRevisions"];
  }>;
};

function parseRoomPublication(value: unknown): ParsedRoomPublication | null {
  if (
    !isRecord(value) ||
    value.contractVersion !== PMS_ROOM_PUBLICATION_CONTRACT_VERSION ||
    !isUuid(value.propertyId) ||
    !Array.isArray(value.rooms)
  ) {
    return null;
  }
  const propertyId = value.propertyId.toLowerCase();
  const rooms = value.rooms.map((room) => parsePublicationRoom(room, propertyId));
  return rooms.some((room) => !room)
    ? null
    : { propertyId, rooms: rooms as ParsedRoomPublication["rooms"] };
}

function parsePublicationRoom(
  value: unknown,
  propertyId: string,
): ParsedRoomPublication["rooms"][number] | null {
  if (
    !isRecord(value) ||
    value.propertyId !== propertyId ||
    !isUuid(value.roomTypeId) ||
    !Number.isSafeInteger(value.activeUnitCount) ||
    !Array.isArray(value.media) ||
    !isRecord(value.sourceRevisions)
  ) {
    return null;
  }
  const facts = parseRoomTypeFacts(value.facts);
  const revisions = value.sourceRevisions;
  if (
    !facts ||
    !positiveRevision(revisions.roomFactsRevision) ||
    !positiveRevision(revisions.roomUnitsRevision) ||
    !positiveRevision(revisions.roomMediaRevision) ||
    !positiveRevision(revisions.roomAmenitiesRevision)
  ) {
    return null;
  }
  const media = value.media.map(parsePublicMedia);
  if (media.some((item) => !item)) return null;
  let amenities: string[] | null = null;
  if (value.amenities !== null) {
    if (!Array.isArray(value.amenities)) return null;
    const parsed = value.amenities.map(parsePmsRoomAmenityKey);
    if (parsed.some((item) => !item)) return null;
    amenities = parsed as string[];
  }
  return {
    roomTypeId: value.roomTypeId.toLowerCase(),
    facts,
    activeUnitCount: value.activeUnitCount as number,
    media: media as RoomPublicationRoomSnapshot["media"],
    amenities,
    sourceRevisions: {
      roomFactsRevision: revisions.roomFactsRevision as number,
      roomUnitsRevision: revisions.roomUnitsRevision as number,
      roomMediaRevision: revisions.roomMediaRevision as number,
      roomAmenitiesRevision: revisions.roomAmenitiesRevision as number,
    },
  };
}

function parsePublicMedia(value: unknown): RoomPublicationRoomSnapshot["media"][number] | null {
  if (
    !isRecord(value) ||
    !isUuid(value.mediaObjectId) ||
    !(value.altText === null || typeof value.altText === "string") ||
    !Number.isSafeInteger(value.sortOrder) ||
    !Array.isArray(value.publicVariants) ||
    value.publicVariants.length === 0
  ) {
    return null;
  }
  const variants = value.publicVariants.flatMap((variant) => {
    if (
      !isRecord(variant) ||
      typeof variant.variantName !== "string" ||
      !httpsUrl(variant.publicUrl)
    ) {
      return [];
    }
    return [{ variantName: variant.variantName, publicUrl: variant.publicUrl }];
  });
  if (variants.length !== value.publicVariants.length) return null;
  const [firstVariant, ...remainingVariants] = variants;
  if (!firstVariant) return null;
  return {
    mediaObjectId: value.mediaObjectId.toLowerCase(),
    altText: value.altText as string | null,
    sortOrder: value.sortOrder as number,
    publicVariants: [
      firstVariant,
      ...remainingVariants,
    ] as RoomPublicationRoomSnapshot["media"][number]["publicVariants"],
  };
}

function parseDraftReceipt(
  value: unknown,
  propertyId: string,
  request: Extract<SavePropertySetupDraftRequest, { stepId: "rooms" }>,
): SavePropertySetupDraftReceipt | null {
  if (
    !isRecord(value) ||
    value.contractVersion !== PROPERTY_SETUP_DRAFT_CONTRACT_VERSION ||
    value.stepId !== "rooms" ||
    typeof value.sessionId !== "string" ||
    !Array.isArray(value.selectedTracks) ||
    !value.selectedTracks.includes("hotel_operations") ||
    !revision(value.trackRevision) ||
    !revision(value.sessionRevision) ||
    !revision(value.draftRevision) ||
    typeof value.retentionExpiresAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.replayed !== "boolean" ||
    value.trackRevision < request.expectedTrackRevision ||
    value.sessionRevision < request.expectedSessionRevision ||
    value.draftRevision < request.expectedDraftRevision
  ) {
    return null;
  }
  void propertyId;
  return value as SavePropertySetupDraftReceipt;
}

type ParsedUploadSession = {
  sessionId: string;
  status: "signed" | "completed";
  targets: Array<{
    uploadTargetId: string;
    clientFileId: string;
    method: "PUT";
    uploadUrl: string;
    headers: Record<string, string>;
  }>;
  mediaObjects: PropertyMediaLibraryItem[] | null;
};

function parseUploadSession(value: unknown, expectedFiles: number): ParsedUploadSession | null {
  if (
    !isRecord(value) ||
    value.contractVersion !== "platform-media-upload.v2" ||
    !isRecord(value.uploadSession) ||
    typeof value.uploadSession.sessionId !== "string" ||
    !(value.uploadSession.status === "signed" || value.uploadSession.status === "completed") ||
    !Array.isArray(value.uploadTargets)
  ) {
    return null;
  }
  const targets = value.uploadTargets.map(parseUploadTarget);
  if (targets.some((target) => !target)) return null;
  const mediaObjects = parseMediaItems(value.mediaObjects, expectedFiles);
  if (value.uploadSession.status === "completed" && !mediaObjects) return null;
  const orderedTargets = Array.from({ length: expectedFiles }, (_, index) =>
    targets.find((target) => target?.clientFileId === `file_${index + 1}`),
  );
  if (
    value.uploadSession.status === "signed" &&
    (targets.length !== expectedFiles ||
      orderedTargets.some((target) => !target) ||
      new Set(targets.map((target) => target?.clientFileId)).size !== targets.length ||
      new Set(targets.map((target) => target?.uploadTargetId)).size !== targets.length)
  ) {
    return null;
  }
  return {
    sessionId: value.uploadSession.sessionId,
    status: value.uploadSession.status,
    targets:
      value.uploadSession.status === "signed"
        ? (orderedTargets as ParsedUploadSession["targets"])
        : [],
    mediaObjects,
  };
}

function parseUploadTarget(value: unknown): ParsedUploadSession["targets"][number] | null {
  if (
    !isRecord(value) ||
    typeof value.uploadTargetId !== "string" ||
    typeof value.clientFileId !== "string" ||
    value.method !== "PUT" ||
    typeof value.uploadUrl !== "string" ||
    !isRecord(value.headers) ||
    !Object.values(value.headers).every((header) => typeof header === "string")
  ) {
    return null;
  }
  return value as ParsedUploadSession["targets"][number];
}

function parseFinalizedMedia(
  value: unknown,
  expectedFiles: number,
): PropertyMediaLibraryItem[] | null {
  return isRecord(value) && value.contractVersion === "platform-media-upload.v2"
    ? parseMediaItems(value.mediaObjects, expectedFiles)
    : null;
}

function parseMediaItems(value: unknown, expectedFiles: number): PropertyMediaLibraryItem[] | null {
  if (!Array.isArray(value) || value.length !== expectedFiles) return null;
  const items = value.map(parsePropertyMediaLibraryItem);
  return items.some((item) => !item || item.purpose !== "pms.room_type.media")
    ? null
    : (items as PropertyMediaLibraryItem[]);
}

async function commandKey(label: string, propertyId: string, value: unknown): Promise<string> {
  return `${label}:${propertyId}:${(await sha256Hex(new TextEncoder().encode(JSON.stringify(value)))).slice(0, 40)}`;
}

function commandKeySync(label: string, propertyId: string, roomId: string, value: unknown): string {
  const source = JSON.stringify(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${label}:${propertyId}:${roomId}:${(hash >>> 0).toString(16)}`.slice(0, 200);
}

function createRoomCommandKey(propertyId: string, draftRoomId: string): string {
  return `room-create:${propertyId}:${draftRoomId}`;
}

async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uploadContentType(file: File): string {
  if (file.type) return file.type;
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return "image/jpeg";
}

function invalidOwnerContract(label: string): Error {
  return new Error(`The protected ${label} adapter returned invalid data.`);
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function setupRoomPath(propertyId: string, suffix: string): string {
  return `/api/pms/setup/properties/${encoded(propertyId)}/${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveRevision(value: unknown): value is number {
  return revision(value) && value >= 1;
}

function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
