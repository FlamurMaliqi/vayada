"use client";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ExclamationTriangleIcon,
  PhotoIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import type { AdaptiveSetupStepRenderContext } from "../AdaptiveHotelSetupController";
import {
  ROOM_AMENITY_GROUPS,
  ROOM_BED_TYPES,
  ROOM_CATEGORIES,
  ROOM_DESCRIPTION_MAX_LENGTH,
  ROOM_MEDIA_MAX_FILE_SIZE,
  ROOM_MEDIA_MAX_ITEMS,
  ROOM_NAME_MAX_LENGTH,
  RoomDraftManifestUnavailableError,
  buildRoomsDraftRequest,
  createEmptyRoomDraft,
  hydrateRoomDrafts,
  roomDraftRevisionContext,
  roomHasInput,
  roomMissingSummary,
  validateRoomDraft,
  type RoomAuthoringDraft,
  type RoomDraftRevisionContext,
  type RoomPhotoDraft,
  type RoomValidationErrors,
} from "./roomAuthoringState";
import { RoomAuthoringOwnerError, roomAuthoringApi } from "@/services/api/roomAuthoringClient";

export type RoomAuthoringSessionStore = {
  propertyId?: string;
  currentStepId?: AdaptiveSetupStepRenderContext["step"]["stepId"];
  rooms?: RoomAuthoringDraft[];
  revision?: RoomDraftRevisionContext;
  dirty?: boolean;
  beforeLeave?: () => Promise<void>;
};

export type RoomAuthoringStepProps = AdaptiveSetupStepRenderContext & {
  sessionStore: RoomAuthoringSessionStore;
};

type WorkspaceState = "loading" | "ready" | "error";
type SaveMode = "add" | "continue";

const COMMON_AMENITIES = ROOM_AMENITY_GROUPS[0].items.slice(0, 5);
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function RoomAuthoringStep({
  route,
  step,
  saveAndContinue,
  refreshRoute,
  reportRevisionConflict,
  sessionStore,
}: RoomAuthoringStepProps) {
  const propertyId = route.scope.propertyId;
  const initialRooms =
    sessionStore.propertyId === propertyId && sessionStore.rooms
      ? sessionStore.rooms
      : hydrateRoomDrafts(step.draft, [], { ensureBlank: true });
  const [rooms, setRooms] = useState<RoomAuthoringDraft[]>(initialRooms);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(
    () =>
      initialRooms.find(({ saved }) => !saved)?.draftRoomId ??
      (initialRooms.some(({ saved }) => saved) ? null : (initialRooms[0]?.draftRoomId ?? null)),
  );
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>("loading");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceReload, setWorkspaceReload] = useState(0);
  const [errors, setErrors] = useState<RoomValidationErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [amenitiesOpen, setAmenitiesOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RoomAuthoringDraft | null>(null);
  const [optionalOpen, setOptionalOpen] = useState(false);
  const [amenityAnnouncement, setAmenityAnnouncement] = useState("");
  const mounted = useRef(true);
  const roomsRef = useRef(rooms);
  const routeRevision = roomDraftRevisionContext(route, step);
  const revisionRef = useRef<RoomDraftRevisionContext>(sessionStore.revision ?? routeRevision);
  const mediaButtonRef = useRef<HTMLButtonElement>(null);
  const amenitiesButtonRef = useRef<HTMLButtonElement>(null);
  const failedUploads = useRef(new Map<string, File>());
  const draftManifestMissing =
    !routeRevision.sessionId ||
    routeRevision.sessionRevision === null ||
    routeRevision.baseRevisions === null;

  if (sessionStore.propertyId !== propertyId) {
    sessionStore.propertyId = propertyId;
    sessionStore.rooms = initialRooms;
    sessionStore.revision = revisionRef.current;
    sessionStore.dirty = false;
  }

  const commitRooms = useCallback(
    (next: RoomAuthoringDraft[], dirty = true) => {
      roomsRef.current = next;
      sessionStore.rooms = next;
      sessionStore.dirty = dirty || sessionStore.dirty === true;
      if (mounted.current) setRooms(next);
    },
    [sessionStore],
  );

  useEffect(() => {
    roomsRef.current = rooms;
    sessionStore.rooms = rooms;
  }, [rooms, sessionStore]);

  useEffect(() => {
    const next = roomDraftRevisionContext(route, step);
    if (
      next.baseRevisions ||
      next.draftRevision > revisionRef.current.draftRevision ||
      next.sessionRevision !== null
    ) {
      revisionRef.current = next;
      sessionStore.revision = next;
    }
  }, [route, sessionStore, step]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const persistDraft = useCallback(
    async (override?: RoomAuthoringDraft[]) => {
      try {
        if (override) {
          sessionStore.rooms = override;
          sessionStore.dirty = true;
        }
        const clean = await saveRoomAuthoringSessionDraft(sessionStore);
        revisionRef.current = sessionStore.revision ?? revisionRef.current;
        roomsRef.current = clean;
        if (mounted.current) {
          setRooms(clean);
          setSaveError(null);
        }
      } catch (error) {
        if (mounted.current) {
          setSaveError(errorMessage(error));
        }
        throw error;
      }
    },
    [sessionStore],
  );

  useEffect(() => {
    const callback = () => persistDraft();
    sessionStore.beforeLeave = callback;
    return () => {
      if (sessionStore.beforeLeave === callback) {
        sessionStore.beforeLeave = undefined;
      }
    };
  }, [persistDraft, sessionStore]);

  useEffect(() => {
    const controller = new AbortController();
    if (draftManifestMissing) {
      setWorkspaceState("ready");
      setWorkspaceError(null);
      return () => controller.abort();
    }
    setWorkspaceState("loading");
    setWorkspaceError(null);
    const draftIds = roomsRef.current.map(({ draftRoomId }) => draftRoomId);
    void roomAuthoringApi
      .loadWorkspace(propertyId, draftIds, { signal: controller.signal, cache: "no-store" })
      .then((canonical) => {
        if (controller.signal.aborted) return;
        const hydrated = hydrateRoomDrafts(step.draft, canonical, { ensureBlank: false });
        const currentById = new Map(roomsRef.current.map((room) => [room.draftRoomId, room]));
        const merged = hydrated.map((room) => {
          const current = currentById.get(room.draftRoomId);
          return current && (current.dirty || sessionStore.dirty)
            ? {
                ...current,
                roomTypeId: room.roomTypeId,
                roomFactsRevision: room.roomFactsRevision,
                roomUnitsRevision: room.roomUnitsRevision,
                roomMediaRevision: room.roomMediaRevision,
                roomAmenitiesRevision: room.roomAmenitiesRevision,
                saved: room.saved,
              }
            : room;
        });
        for (const current of roomsRef.current) {
          if (!merged.some(({ draftRoomId }) => draftRoomId === current.draftRoomId)) {
            merged.push(current);
          }
        }
        if (merged.length === 0) merged.push(createEmptyRoomDraft());
        commitRooms(merged, false);
        const current = merged.find(({ draftRoomId }) => draftRoomId === activeRoomId);
        const incomplete =
          current && (!current.saved || Object.keys(validateRoomDraft(current, merged)).length > 0)
            ? current
            : merged.find(
                (room) => !room.saved || Object.keys(validateRoomDraft(room, merged)).length > 0,
              );
        setActiveRoomId(incomplete?.draftRoomId ?? null);
        setWorkspaceState("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setWorkspaceState("error");
        setWorkspaceError(
          error instanceof Error && error.message
            ? error.message
            : "Canonical room data could not be loaded.",
        );
      });
    return () => controller.abort();
    // The explicit reload counter controls owner reads; local edits do not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftManifestMissing, propertyId, step.draft, workspaceReload]);

  const activeRoom = rooms.find(({ draftRoomId }) => draftRoomId === activeRoomId) ?? null;
  const firstIncompleteRoom = rooms.find(
    (room) => !room.saved || Object.keys(validateRoomDraft(room, rooms)).length > 0,
  );
  const allRoomsComplete = rooms.length > 0 && !firstIncompleteRoom;
  const photoPreparationErrors = activeRoom ? roomCoreValidationErrors(activeRoom, rooms) : {};
  const photoActionUnavailable =
    draftManifestMissing ||
    workspaceState !== "ready" ||
    saving ||
    Object.keys(photoPreparationErrors).length > 0;
  const roomSwitchBlocked = Boolean(activeRoom && (!activeRoom.saved || activeRoom.dirty));

  const updateRoom = useCallback(
    (roomId: string, update: (room: RoomAuthoringDraft) => RoomAuthoringDraft) => {
      const next = roomsRef.current.map((room) =>
        room.draftRoomId === roomId ? { ...update(room), dirty: true } : room,
      );
      commitRooms(next);
      setSaveError(null);
    },
    [commitRooms],
  );

  const updateActive = useCallback(
    (patch: Partial<RoomAuthoringDraft>) => {
      if (!activeRoomId) return;
      updateRoom(activeRoomId, (room) => ({ ...room, ...patch }));
    },
    [activeRoomId, updateRoom],
  );

  const clearError = (key: string) => {
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const saveActiveRoom = async (mode: SaveMode) => {
    const room = roomsRef.current.find(({ draftRoomId }) => draftRoomId === activeRoomId);
    if (!room) {
      if (mode === "continue") await saveAndContinue();
      return;
    }
    if (!roomHasInput(room) && roomsRef.current.some(({ saved }) => saved)) {
      const withoutBlank = roomsRef.current.filter(
        ({ draftRoomId }) => draftRoomId !== room.draftRoomId,
      );
      commitRooms(withoutBlank, false);
      setActiveRoomId(null);
      if (mode === "continue") await saveAndContinue();
      return;
    }

    const nextErrors = validateRoomDraft(room, roomsRef.current);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setSaveError("Review the highlighted room details before saving.");
      focusFirstError(room, nextErrors);
      return;
    }
    if (workspaceState !== "ready") {
      setSaveError("Protected room data is unavailable. Retry the connection before saving.");
      return;
    }
    if (draftManifestMissing) {
      setSaveError(
        "Setup data is still unavailable. Refresh this step before saving your room draft.",
      );
      return;
    }

    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      await persistDraft(roomsRef.current);
      const persistedRoom =
        roomsRef.current.find(({ draftRoomId }) => draftRoomId === room.draftRoomId) ?? room;
      const target = await roomAuthoringApi.ensureRoomTarget({ propertyId, room: persistedRoom });
      const targetedRoom = {
        ...persistedRoom,
        roomTypeId: target.roomTypeId,
        roomFactsRevision: target.roomFactsRevision,
      };
      commitRooms(
        roomsRef.current.map((candidate) =>
          candidate.draftRoomId === room.draftRoomId ? targetedRoom : candidate,
        ),
        false,
      );
      const saved = await roomAuthoringApi.saveRoom({ propertyId, room: targetedRoom });
      const next = roomsRef.current.map((candidate) =>
        candidate.draftRoomId === room.draftRoomId
          ? {
              ...candidate,
              roomTypeId: saved.roomTypeId,
              roomFactsRevision: saved.roomFactsRevision,
              roomUnitsRevision: saved.roomUnitsRevision,
              roomMediaRevision: saved.roomMediaRevision,
              roomAmenitiesRevision: saved.roomAmenitiesRevision,
              saved: true,
              dirty: false,
            }
          : candidate,
      );
      commitRooms(next, false);
      const pending = next.find(
        (candidate) => candidate.draftRoomId !== room.draftRoomId && !candidate.saved,
      );
      if (mode === "add") {
        const nextRoom = pending ?? createEmptyRoomDraft();
        if (!pending) commitRooms([...roomsRef.current, nextRoom], false);
        setActiveRoomId(nextRoom.draftRoomId);
        setErrors({});
        setOptionalOpen(false);
        setNotice(`${saved.facts.name} was saved. Add the next room type.`);
        requestAnimationFrame(() =>
          document.getElementById(`${nextRoom.draftRoomId}-name`)?.focus(),
        );
      } else if (pending && roomHasInput(pending)) {
        setActiveRoomId(pending.draftRoomId);
        setErrors({});
        setOptionalOpen(false);
        setNotice(`${saved.facts.name} was saved. Complete the next room type to continue.`);
        requestAnimationFrame(() =>
          document.getElementById(`${pending.draftRoomId}-name`)?.focus(),
        );
      } else {
        if (pending) {
          commitRooms(
            next.filter(({ draftRoomId }) => draftRoomId !== pending.draftRoomId),
            false,
          );
        }
        await saveAndContinue();
      }
    } catch (error) {
      if (error instanceof RoomAuthoringOwnerError && error.requiresRefresh) {
        reportRevisionConflict(error.message);
      } else {
        setSaveError(errorMessage(error));
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!activeRoom || files.length === 0) return;
    if (draftManifestMissing) {
      setSaveError("Setup data is still unavailable. Refresh before uploading room photos.");
      return;
    }
    const requiredErrors = roomCoreValidationErrors(activeRoom, roomsRef.current);
    if (Object.keys(requiredErrors).length > 0) {
      setErrors(requiredErrors);
      setSaveError("Complete the required room details before uploading photos.");
      focusFirstError(activeRoom, requiredErrors);
      return;
    }
    const available = ROOM_MEDIA_MAX_ITEMS - activeRoom.photos.length;
    const selected = files.slice(0, Math.max(0, available));
    const invalid = selected.find(
      (file) => !ALLOWED_IMAGE_TYPES.has(file.type) || file.size > ROOM_MEDIA_MAX_FILE_SIZE,
    );
    if (files.length > available) {
      setSaveError(`A room can have at most ${ROOM_MEDIA_MAX_ITEMS} photos.`);
      return;
    }
    if (invalid) {
      setSaveError("Use JPEG, PNG, or WebP photos no larger than 10 MB each.");
      return;
    }

    let placeholders: RoomPhotoDraft[] = [];
    setSaving(true);
    try {
      await persistDraft(roomsRef.current);
      placeholders = selected.map((file) => {
        const mediaObjectId = `upload:${crypto.randomUUID()}`;
        failedUploads.current.set(mediaObjectId, file);
        return {
          mediaObjectId,
          previewUrl: URL.createObjectURL(file),
          uploadState: "uploading" as const,
          errorMessage: null,
        };
      });
      updateActive({ photos: [...activeRoom.photos, ...placeholders] });
      const target = await roomAuthoringApi.ensureRoomTarget({ propertyId, room: activeRoom });
      updateRoom(activeRoom.draftRoomId, (current) => ({
        ...current,
        roomTypeId: target.roomTypeId,
        roomFactsRevision: target.roomFactsRevision,
      }));
      const uploaded = await roomAuthoringApi.uploadRoomPhotos({
        propertyId,
        roomTypeId: target.roomTypeId,
        draftRoomId: activeRoom.draftRoomId,
        files: selected,
      });
      updateRoom(activeRoom.draftRoomId, (current) => ({
        ...current,
        photos: current.photos.map((photo) => {
          const index = placeholders.findIndex(
            ({ mediaObjectId }) => mediaObjectId === photo.mediaObjectId,
          );
          if (index < 0) return photo;
          failedUploads.current.delete(photo.mediaObjectId);
          return {
            ...photo,
            mediaObjectId: uploaded[index]!.mediaObjectId,
            uploadState: "ready",
            errorMessage: null,
          };
        }),
      }));
      clearError("photos");
    } catch (error) {
      const message = errorMessage(error);
      if (placeholders.length > 0) {
        updateRoom(activeRoom.draftRoomId, (current) => ({
          ...current,
          photos: current.photos.map((photo) =>
            placeholders.some(({ mediaObjectId }) => mediaObjectId === photo.mediaObjectId)
              ? { ...photo, uploadState: "failed", errorMessage: message }
              : photo,
          ),
        }));
      }
      if (error instanceof RoomAuthoringOwnerError && error.requiresRefresh) {
        reportRevisionConflict(error.message);
      } else {
        setSaveError(message);
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const retryPhoto = async (photo: RoomPhotoDraft) => {
    const file = failedUploads.current.get(photo.mediaObjectId);
    if (!file || !activeRoom) return;
    if (draftManifestMissing) {
      setSaveError("Setup data is still unavailable. Refresh before retrying this photo.");
      return;
    }
    const requiredErrors = roomCoreValidationErrors(activeRoom, roomsRef.current);
    if (Object.keys(requiredErrors).length > 0) {
      setErrors(requiredErrors);
      setSaveError("Complete the required room details before retrying this photo.");
      focusFirstError(activeRoom, requiredErrors);
      return;
    }
    setSaving(true);
    updateRoom(activeRoom.draftRoomId, (current) => ({
      ...current,
      photos: current.photos.map((candidate) =>
        candidate.mediaObjectId === photo.mediaObjectId
          ? { ...candidate, uploadState: "uploading", errorMessage: null }
          : candidate,
      ),
    }));
    try {
      await persistDraft(roomsRef.current);
      const target = await roomAuthoringApi.ensureRoomTarget({ propertyId, room: activeRoom });
      updateRoom(activeRoom.draftRoomId, (current) => ({
        ...current,
        roomTypeId: target.roomTypeId,
        roomFactsRevision: target.roomFactsRevision,
      }));
      const [uploaded] = await roomAuthoringApi.uploadRoomPhotos({
        propertyId,
        roomTypeId: target.roomTypeId,
        draftRoomId: activeRoom.draftRoomId,
        files: [file],
      });
      updateRoom(activeRoom.draftRoomId, (current) => ({
        ...current,
        photos: current.photos.map((candidate) =>
          candidate.mediaObjectId === photo.mediaObjectId
            ? {
                ...candidate,
                mediaObjectId: uploaded!.mediaObjectId,
                uploadState: "ready",
                errorMessage: null,
              }
            : candidate,
        ),
      }));
      failedUploads.current.delete(photo.mediaObjectId);
    } catch (error) {
      updateRoom(activeRoom.draftRoomId, (current) => ({
        ...current,
        photos: current.photos.map((candidate) =>
          candidate.mediaObjectId === photo.mediaObjectId
            ? { ...candidate, uploadState: "failed", errorMessage: errorMessage(error) }
            : candidate,
        ),
      }));
      if (error instanceof RoomAuthoringOwnerError && error.requiresRefresh) {
        reportRevisionConflict(error.message);
      } else {
        setSaveError(errorMessage(error));
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const movePhoto = (index: number, direction: -1 | 1) => {
    if (!activeRoom) return;
    const target = index + direction;
    if (target < 0 || target >= activeRoom.photos.length) return;
    const next = [...activeRoom.photos];
    [next[index], next[target]] = [next[target]!, next[index]!];
    updateActive({ photos: next });
  };

  const removePhoto = (index: number) => {
    if (!activeRoom) return;
    const photo = activeRoom.photos[index];
    if (photo?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(photo.previewUrl);
    updateActive({ photos: activeRoom.photos.filter((_, candidate) => candidate !== index) });
  };

  const toggleAmenity = (key: string, label: string) => {
    if (!activeRoom) return;
    const selected = activeRoom.amenityKeys.includes(key);
    const keys = selected
      ? activeRoom.amenityKeys.filter((candidate) => candidate !== key)
      : [...activeRoom.amenityKeys, key];
    updateActive({ amenityKeys: keys, reviewedEmptyAmenities: false });
    clearError("amenities");
    setAmenityAnnouncement(
      `${label} ${selected ? "removed" : "selected"}. ${keys.length} selected.`,
    );
  };

  const confirmNoAmenities = (checked: boolean) => {
    updateActive({
      reviewedEmptyAmenities: checked,
      amenityKeys: checked ? [] : (activeRoom?.amenityKeys ?? []),
    });
    clearError("amenities");
    setAmenityAnnouncement(
      checked
        ? "No additional room amenities confirmed. Selections cleared."
        : "Empty amenity confirmation removed.",
    );
  };

  const confirmRemoval = async () => {
    const target = removeTarget;
    if (!target) return;
    setSaving(true);
    setSaveError(null);
    try {
      await roomAuthoringApi.removeRoom(propertyId, target);
      const next = roomsRef.current.filter(({ draftRoomId }) => draftRoomId !== target.draftRoomId);
      const remaining = next.length > 0 ? next : [createEmptyRoomDraft()];
      commitRooms(remaining);
      setActiveRoomId(remaining.find(({ saved }) => !saved)?.draftRoomId ?? null);
      setRemoveTarget(null);
      await persistDraft(roomsRef.current);
      setNotice(`${target.name.trim() || "Room type"} was removed.`);
    } catch (error) {
      if (error instanceof RoomAuthoringOwnerError && error.requiresRefresh) {
        reportRevisionConflict(error.message);
      } else {
        setSaveError(errorMessage(error));
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const discardUntouched = () => {
    if (!activeRoom) return;
    const next = roomsRef.current.filter(
      ({ draftRoomId }) => draftRoomId !== activeRoom.draftRoomId,
    );
    if (next.length === 0) {
      const fresh = createEmptyRoomDraft();
      commitRooms([fresh], false);
      setActiveRoomId(fresh.draftRoomId);
    } else {
      commitRooms(next, false);
      setActiveRoomId(null);
    }
  };

  return (
    <div className="space-y-6">
      {draftManifestMissing && (
        <RecoveryBanner
          title="Setup data is still unavailable"
          message="You can keep editing this room. Refresh before saving or leaving so Vayada can protect the latest room revisions."
          actionLabel="Refresh setup data"
          onAction={() => void refreshRoute()}
          tone="warning"
        />
      )}
      {workspaceState === "error" && (
        <RecoveryBanner
          title="Protected room data could not be loaded"
          message={workspaceError ?? "The PMS room adapter is unavailable."}
          actionLabel="Retry connection"
          onAction={() => setWorkspaceReload((value) => value + 1)}
          tone="danger"
        />
      )}
      {workspaceState === "loading" && (
        <p className="text-sm text-gray-600" role="status" aria-live="polite">
          Checking saved room details...
        </p>
      )}
      {notice && (
        <div
          className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          role="status"
          aria-live="polite"
        >
          {notice}
        </div>
      )}
      {saveError && (
        <div
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          role="alert"
        >
          {saveError}
        </div>
      )}

      {rooms.filter(({ draftRoomId, saved }) => saved && draftRoomId !== activeRoomId).length >
        0 && (
        <section aria-labelledby="saved-room-types-heading">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h2 id="saved-room-types-heading" className="text-sm font-semibold text-gray-950">
              Your room types
            </h2>
            {!activeRoom && (
              <button
                type="button"
                onClick={() => {
                  const fresh = createEmptyRoomDraft();
                  commitRooms([...roomsRef.current, fresh], false);
                  setActiveRoomId(fresh.draftRoomId);
                }}
                className={secondaryButtonClass}
              >
                <PlusIcon className="h-4 w-4" aria-hidden="true" />
                Add another room type
              </button>
            )}
          </div>
          <div className="space-y-3">
            {rooms
              .filter(({ draftRoomId, saved }) => saved && draftRoomId !== activeRoomId)
              .map((room) => (
                <RoomSummary
                  key={room.draftRoomId}
                  room={room}
                  rooms={rooms}
                  editDisabled={roomSwitchBlocked}
                  onEdit={() => {
                    setErrors({});
                    setActiveRoomId(room.draftRoomId);
                    setOptionalOpen(false);
                  }}
                />
              ))}
          </div>
        </section>
      )}

      {activeRoom ? (
        <section
          className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-7"
          aria-labelledby={`${activeRoom.draftRoomId}-form-heading`}
        >
          <div className="flex flex-col gap-3 border-b border-gray-100 pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary-700">
                {activeRoom.saved ? "Edit room type" : "New room type"}
              </p>
              <h2
                id={`${activeRoom.draftRoomId}-form-heading`}
                className="mt-1 text-lg font-semibold text-gray-950"
              >
                {activeRoom.name.trim() || "Room details"}
              </h2>
            </div>
            <button
              type="button"
              onClick={() =>
                roomHasInput(activeRoom) || activeRoom.saved
                  ? setRemoveTarget(activeRoom)
                  : discardUntouched()
              }
              className="inline-flex min-h-10 items-center gap-2 self-start rounded-lg px-3 text-sm font-semibold text-gray-600 outline-none hover:bg-red-50 hover:text-red-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
            >
              <TrashIcon className="h-4 w-4" aria-hidden="true" />
              {roomHasInput(activeRoom) || activeRoom.saved
                ? "Remove room type"
                : "Discard blank room"}
            </button>
          </div>

          {Object.keys(errors).length > 0 && (
            <div
              className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
              role="alert"
            >
              <p className="font-semibold">Complete the highlighted fields.</p>
              <p className="mt-1">Your entries are still here and have not been discarded.</p>
            </div>
          )}

          <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <TextField
              id={`${activeRoom.draftRoomId}-name`}
              label="Room type name"
              required
              value={activeRoom.name}
              maxLength={ROOM_NAME_MAX_LENGTH}
              placeholder="Deluxe Double Room"
              help="Guests see this name when choosing a room."
              error={errors.name}
              onChange={(value) => {
                updateActive({ name: value });
                clearError("name");
              }}
            />
            <TextField
              id={`${activeRoom.draftRoomId}-unitCount`}
              label="Number of rooms of this type"
              required
              type="number"
              min="1"
              max="500"
              inputMode="numeric"
              value={activeRoom.unitCount}
              help="Vayada creates one PMS room for each unit. Add room numbers later."
              error={errors.unitCount}
              onChange={(value) => {
                updateActive({ unitCount: value });
                clearError("unitCount");
              }}
            />
            <TextField
              id={`${activeRoom.draftRoomId}-maxGuests`}
              label="Maximum guests"
              required
              type="number"
              min="1"
              max="100"
              inputMode="numeric"
              value={activeRoom.maxGuests}
              error={errors.maxGuests}
              onChange={(value) => {
                updateActive({ maxGuests: value });
                clearError("maxGuests");
              }}
            />
            <fieldset className="min-w-0">
              <legend className={labelClass}>
                Bathroom <Required />
              </legend>
              <div className="mt-2 flex min-h-12 flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-gray-300 px-4">
                {(
                  [
                    ["private", "Private bathroom"],
                    ["shared", "Shared bathroom"],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm text-gray-800"
                  >
                    <input
                      id={
                        value === "private" ? `${activeRoom.draftRoomId}-bathroomType` : undefined
                      }
                      type="radio"
                      name={`${activeRoom.draftRoomId}-bathroom`}
                      value={value}
                      checked={activeRoom.bathroomType === value}
                      onChange={() => {
                        updateActive({ bathroomType: value });
                        clearError("bathroomType");
                      }}
                      aria-describedby={
                        errors.bathroomType ? `${activeRoom.draftRoomId}-bathroom-error` : undefined
                      }
                      className="h-4 w-4 border-gray-300 text-primary-600 focus:ring-primary-600"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <FieldError
                id={`${activeRoom.draftRoomId}-bathroom-error`}
                message={errors.bathroomType}
              />
            </fieldset>
          </div>

          <fieldset className="mt-6">
            <legend className={labelClass}>
              Beds <Required />
            </legend>
            <p className="mt-1 text-sm text-gray-600">Add every bed guests can use in this room.</p>
            <div className="mt-3 space-y-3">
              {activeRoom.beds.map((bed, index) => (
                <div
                  key={bed.id}
                  className="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-end gap-2"
                >
                  <div>
                    <label
                      htmlFor={`${activeRoom.draftRoomId}-bedType-${index}`}
                      className="text-xs font-medium text-gray-700"
                    >
                      Bed type
                    </label>
                    <select
                      id={`${activeRoom.draftRoomId}-bedType-${index}`}
                      value={bed.type}
                      onChange={(event) => {
                        const next = activeRoom.beds.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, type: event.target.value }
                            : candidate,
                        );
                        updateActive({ beds: next });
                        clearError(`bedType.${index}`);
                      }}
                      aria-invalid={Boolean(errors[`bedType.${index}`])}
                      aria-describedby={
                        errors[`bedType.${index}`]
                          ? `${activeRoom.draftRoomId}-bedType-${index}-error`
                          : undefined
                      }
                      className={inputClass(Boolean(errors[`bedType.${index}`]))}
                    >
                      <option value="">Choose a bed</option>
                      {ROOM_BED_TYPES.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <FieldError
                      id={`${activeRoom.draftRoomId}-bedType-${index}-error`}
                      message={errors[`bedType.${index}`]}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`${activeRoom.draftRoomId}-bedQuantity-${index}`}
                      className="text-xs font-medium text-gray-700"
                    >
                      Quantity
                    </label>
                    <input
                      id={`${activeRoom.draftRoomId}-bedQuantity-${index}`}
                      type="number"
                      min="1"
                      max="20"
                      inputMode="numeric"
                      value={bed.quantity}
                      onChange={(event) => {
                        const next = activeRoom.beds.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, quantity: event.target.value }
                            : candidate,
                        );
                        updateActive({ beds: next });
                        clearError(`bedQuantity.${index}`);
                      }}
                      aria-invalid={Boolean(errors[`bedQuantity.${index}`])}
                      aria-describedby={
                        errors[`bedQuantity.${index}`]
                          ? `${activeRoom.draftRoomId}-bedQuantity-${index}-error`
                          : undefined
                      }
                      className={inputClass(Boolean(errors[`bedQuantity.${index}`]))}
                    />
                    <FieldError
                      id={`${activeRoom.draftRoomId}-bedQuantity-${index}-error`}
                      message={errors[`bedQuantity.${index}`]}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      updateActive({
                        beds: activeRoom.beds.filter((_, candidate) => candidate !== index),
                      })
                    }
                    disabled={activeRoom.beds.length === 1}
                    aria-label={`Remove bed ${index + 1}`}
                    className="mb-0.5 inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 outline-none hover:bg-red-50 hover:text-red-700 focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <TrashIcon className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                updateActive({
                  beds: [
                    ...activeRoom.beds,
                    {
                      id: `${activeRoom.draftRoomId}:bed:${crypto.randomUUID()}`,
                      type: "",
                      quantity: "1",
                    },
                  ],
                })
              }
              className={`${secondaryButtonClass} mt-3`}
            >
              <PlusIcon className="h-4 w-4" aria-hidden="true" /> Add another bed
            </button>
          </fieldset>

          <div className="mt-6">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={`${activeRoom.draftRoomId}-description`} className={labelClass}>
                Room description
              </label>
              <span className="text-xs font-medium text-gray-500">Recommended</span>
            </div>
            <textarea
              id={`${activeRoom.draftRoomId}-description`}
              value={activeRoom.description}
              maxLength={ROOM_DESCRIPTION_MAX_LENGTH}
              rows={5}
              placeholder="Describe the room, its layout, and what makes it comfortable or distinctive."
              onChange={(event) => {
                updateActive({ description: event.target.value });
                clearError("description");
              }}
              aria-invalid={Boolean(errors.description)}
              aria-describedby={
                errors.description ? `${activeRoom.draftRoomId}-description-error` : undefined
              }
              className={`${inputClass(Boolean(errors.description))} resize-y`}
            />
            <div className="mt-1 flex justify-between gap-4 text-xs text-gray-500">
              <FieldError
                id={`${activeRoom.draftRoomId}-description-error`}
                message={errors.description}
              />
              <span className="ml-auto tabular-nums">
                {activeRoom.description.length}/{ROOM_DESCRIPTION_MAX_LENGTH}
              </span>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <fieldset>
              <legend className={labelClass}>
                Room photos <Required />
              </legend>
              <p className="mt-1 text-sm text-gray-600">
                Add at least one clear photo. Three to five is ideal.
              </p>
              {activeRoom.photos.length > 0 && <PhotoGrid photos={activeRoom.photos} compact />}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  id={`${activeRoom.draftRoomId}-photos`}
                  ref={mediaButtonRef}
                  type="button"
                  onClick={() => setMediaOpen(true)}
                  disabled={photoActionUnavailable}
                  aria-describedby={[
                    `${activeRoom.draftRoomId}-photo-action-help`,
                    errors.photos ? `${activeRoom.draftRoomId}-photos-error` : null,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  className={secondaryButtonClass}
                >
                  <PhotoIcon className="h-4 w-4" aria-hidden="true" /> Add or arrange photos
                </button>
              </div>
              <p
                id={`${activeRoom.draftRoomId}-photo-action-help`}
                className="mt-2 text-xs text-gray-500"
              >
                {draftManifestMissing
                  ? "Refresh setup data before uploading. Your room entries will stay here."
                  : Object.keys(photoPreparationErrors).length > 0
                    ? "Complete the required room details before uploading."
                    : workspaceState !== "ready"
                      ? "Protected room data must be available before uploading."
                      : "Existing hotel photos cannot be reused here; upload new room photos."}
              </p>
              <FieldError id={`${activeRoom.draftRoomId}-photos-error`} message={errors.photos} />
            </fieldset>

            <fieldset>
              <legend className={labelClass}>
                Room amenities <Required />
              </legend>
              <p className="mt-1 text-sm text-gray-600">
                Choose what guests can expect inside this room.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {COMMON_AMENITIES.map(([key, label]) => {
                  const selected = activeRoom.amenityKeys.includes(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleAmenity(key, label)}
                      className={`min-h-10 rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 ${selected ? "border-primary-600 bg-primary-50 text-primary-800" : "border-gray-300 bg-white text-gray-700 hover:border-gray-400"}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <button
                id={`${activeRoom.draftRoomId}-amenities`}
                ref={amenitiesButtonRef}
                type="button"
                onClick={() => setAmenitiesOpen(true)}
                aria-describedby={
                  errors.amenities ? `${activeRoom.draftRoomId}-amenities-error` : undefined
                }
                className={`${secondaryButtonClass} mt-3`}
              >
                View all amenities ({activeRoom.amenityKeys.length} selected)
              </button>
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 px-3 py-3 text-sm text-gray-800">
                <input
                  type="checkbox"
                  checked={activeRoom.reviewedEmptyAmenities}
                  onChange={(event) => confirmNoAmenities(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
                />
                No additional room amenities apply.
              </label>
              <FieldError
                id={`${activeRoom.draftRoomId}-amenities-error`}
                message={errors.amenities}
              />
              <span className="sr-only" role="status" aria-live="polite">
                {amenityAnnouncement}
              </span>
            </fieldset>
          </div>

          <div className="mt-6 rounded-xl border border-gray-200">
            <button
              type="button"
              aria-expanded={optionalOpen}
              onClick={() => setOptionalOpen((value) => !value)}
              className="flex min-h-12 w-full items-center justify-between gap-4 rounded-xl px-4 text-left text-sm font-semibold text-gray-900 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
            >
              <span>
                More room details{" "}
                <span className="font-normal text-gray-500">
                  Category, guest limits, bedrooms, bathrooms, size
                </span>
              </span>
              <ChevronDownIcon
                className={`h-4 w-4 shrink-0 transition-transform ${optionalOpen ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
            {optionalOpen && (
              <div className="grid grid-cols-1 gap-5 border-t border-gray-200 p-4 sm:grid-cols-2">
                <div>
                  <label htmlFor={`${activeRoom.draftRoomId}-category`} className={labelClass}>
                    Room category
                  </label>
                  <select
                    id={`${activeRoom.draftRoomId}-category`}
                    value={activeRoom.category}
                    onChange={(event) => updateActive({ category: event.target.value })}
                    className={inputClass(false)}
                  >
                    <option value="">Choose a category</option>
                    {ROOM_CATEGORIES.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-gray-200 px-4 text-sm font-medium text-gray-800 sm:mt-6">
                  <input
                    type="checkbox"
                    checked={activeRoom.separateOccupancy}
                    onChange={(event) =>
                      updateActive({
                        separateOccupancy: event.target.checked,
                        maxAdults: event.target.checked ? activeRoom.maxAdults : "",
                        maxChildren: event.target.checked ? activeRoom.maxChildren : "",
                      })
                    }
                    className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
                  />
                  Set separate adult and child limits
                </label>
                {activeRoom.separateOccupancy && (
                  <>
                    <TextField
                      id={`${activeRoom.draftRoomId}-maxAdults`}
                      label="Maximum adults"
                      type="number"
                      min="1"
                      max={activeRoom.maxGuests || "100"}
                      value={activeRoom.maxAdults}
                      error={errors.maxAdults}
                      onChange={(value) => {
                        updateActive({ maxAdults: value });
                        clearError("maxAdults");
                      }}
                    />
                    <TextField
                      id={`${activeRoom.draftRoomId}-maxChildren`}
                      label="Maximum children"
                      type="number"
                      min="0"
                      max={activeRoom.maxGuests || "100"}
                      value={activeRoom.maxChildren}
                      error={errors.maxChildren}
                      onChange={(value) => {
                        updateActive({ maxChildren: value });
                        clearError("maxChildren");
                      }}
                    />
                  </>
                )}
                <TextField
                  id={`${activeRoom.draftRoomId}-bedrooms`}
                  label="Bedrooms"
                  type="number"
                  min="0"
                  max="100"
                  value={activeRoom.bedrooms}
                  error={errors.bedrooms}
                  onChange={(value) => {
                    updateActive({ bedrooms: value });
                    clearError("bedrooms");
                  }}
                />
                {activeRoom.bathroomType === "private" && (
                  <TextField
                    id={`${activeRoom.draftRoomId}-bathrooms`}
                    label="Number of bathrooms"
                    type="number"
                    min="0.5"
                    max="100"
                    step="0.5"
                    value={activeRoom.bathrooms}
                    error={errors.bathrooms}
                    onChange={(value) => {
                      updateActive({ bathrooms: value });
                      clearError("bathrooms");
                    }}
                  />
                )}
                <TextField
                  id={`${activeRoom.draftRoomId}-sizeSquareMetres`}
                  label="Room size in square metres"
                  type="number"
                  min="1"
                  max="100000"
                  step="0.1"
                  value={activeRoom.sizeSquareMetres}
                  error={errors.sizeSquareMetres}
                  onChange={(value) => {
                    updateActive({ sizeSquareMetres: value });
                    clearError("sizeSquareMetres");
                  }}
                />
              </div>
            )}
          </div>

          <div className="mt-7 flex flex-col-reverse gap-3 border-t border-gray-100 pt-6 sm:flex-row sm:justify-end">
            <button
              type="button"
              disabled={saving}
              onClick={() => void saveActiveRoom("add")}
              className={`${secondaryButtonClass} w-full justify-center sm:w-auto`}
            >
              {saving ? "Saving..." : "Save and add another"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void saveActiveRoom("continue")}
              className={`${primaryButtonClass} w-full justify-center sm:w-auto`}
            >
              {saving ? "Saving..." : "Save and continue"}
            </button>
          </div>

          {mediaOpen && (
            <AccessibleDialog
              title="Room photos"
              onClose={() => setMediaOpen(false)}
              returnFocusRef={mediaButtonRef}
            >
              <p className="text-sm leading-6 text-gray-600">
                Upload JPEG, PNG, or WebP photos up to 10 MB. The first photo is the room cover.
              </p>
              <label className={`${primaryButtonClass} mt-4 cursor-pointer justify-center`}>
                <PhotoIcon className="h-4 w-4" aria-hidden="true" /> Upload photos
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  className="sr-only"
                  disabled={photoActionUnavailable}
                  onChange={(event) => void handleFiles(event)}
                />
              </label>
              <div className="mt-5">
                {activeRoom.photos.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-300 px-5 py-10 text-center text-sm text-gray-600">
                    No room photos yet.
                  </div>
                ) : (
                  <PhotoGrid
                    photos={activeRoom.photos}
                    onMove={movePhoto}
                    onRemove={removePhoto}
                    onRetry={(photo) => void retryPhoto(photo)}
                  />
                )}
              </div>
            </AccessibleDialog>
          )}

          {amenitiesOpen && (
            <AccessibleDialog
              title="All room amenities"
              onClose={() => setAmenitiesOpen(false)}
              returnFocusRef={amenitiesButtonRef}
            >
              <p className="text-sm text-gray-600" role="status" aria-live="polite">
                {activeRoom.amenityKeys.length} selected
              </p>
              <div className="mt-5 space-y-6">
                {ROOM_AMENITY_GROUPS.map((group) => (
                  <fieldset key={group.label}>
                    <legend className="text-sm font-semibold text-gray-950">{group.label}</legend>
                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {group.items.map(([key, label]) => (
                        <label
                          key={key}
                          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-gray-200 px-3 text-sm text-gray-800 hover:bg-gray-50"
                        >
                          <input
                            type="checkbox"
                            checked={activeRoom.amenityKeys.includes(key)}
                            onChange={() => toggleAmenity(key, label)}
                            className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>
            </AccessibleDialog>
          )}
        </section>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white px-5 py-7 text-center shadow-sm sm:px-8">
          {allRoomsComplete ? (
            <CheckCircleIcon className="mx-auto h-8 w-8 text-emerald-600" aria-hidden="true" />
          ) : (
            <ExclamationTriangleIcon
              className="mx-auto h-8 w-8 text-amber-600"
              aria-hidden="true"
            />
          )}
          <h2 className="mt-3 text-base font-semibold text-gray-950">
            {allRoomsComplete ? "Room types saved" : "Room details need attention"}
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            {allRoomsComplete
              ? "Add another room type or continue to room pricing."
              : "Review the unfinished room before continuing."}
          </p>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-center">
            {allRoomsComplete ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const fresh = createEmptyRoomDraft();
                    commitRooms([...roomsRef.current, fresh], false);
                    setActiveRoomId(fresh.draftRoomId);
                  }}
                  className={`${secondaryButtonClass} justify-center`}
                >
                  <PlusIcon className="h-4 w-4" aria-hidden="true" /> Add another room type
                </button>
                <button
                  type="button"
                  onClick={() => void saveAndContinue()}
                  className={`${primaryButtonClass} justify-center`}
                >
                  Save and continue
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setActiveRoomId(firstIncompleteRoom?.draftRoomId ?? null)}
                className={`${primaryButtonClass} justify-center`}
              >
                Review unfinished room
              </button>
            )}
          </div>
        </div>
      )}

      {removeTarget && (
        <AccessibleDialog
          title={removeTarget.saved ? "Remove this room type?" : "Discard this room draft?"}
          onClose={() => setRemoveTarget(null)}
        >
          <p className="text-sm leading-6 text-gray-600">
            {removeTarget.saved
              ? "Vayada will first check bookings, assigned or verified rooms, channel mappings, pricing, calendar, and other operational references. Shared photos will not be deleted."
              : "This removes the unfinished room draft and its photo assignments. Shared photos will not be deleted."}
          </p>
          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setRemoveTarget(null)}
              className={`${secondaryButtonClass} justify-center`}
            >
              Keep room
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void confirmRemoval()}
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-red-700 px-5 text-sm font-semibold text-white outline-none hover:bg-red-800 focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2 disabled:opacity-50"
            >
              {saving ? "Checking..." : "Remove room type"}
            </button>
          </div>
        </AccessibleDialog>
      )}
    </div>
  );
}

/** Saves retained room values without retaining a mounted component callback. */
export async function saveRoomAuthoringSessionDraft(
  sessionStore: RoomAuthoringSessionStore,
): Promise<RoomAuthoringDraft[]> {
  const nextRooms = sessionStore.rooms ?? [];
  if (sessionStore.dirty !== true && !nextRooms.some(({ dirty }) => dirty)) return nextRooms;
  if (!sessionStore.propertyId || !sessionStore.revision) {
    throw new RoomDraftManifestUnavailableError();
  }
  const request = buildRoomsDraftRequest(nextRooms, sessionStore.revision);
  const receipt = await roomAuthoringApi.saveDraft(sessionStore.propertyId, request);
  sessionStore.revision = {
    ...sessionStore.revision,
    sessionId: receipt.sessionId,
    trackRevision: receipt.trackRevision,
    sessionRevision: receipt.sessionRevision,
    draftRevision: receipt.draftRevision,
  };
  sessionStore.dirty = false;
  const clean = nextRooms.map((room) => ({ ...room, dirty: false }));
  sessionStore.rooms = clean;
  return clean;
}

function RoomSummary({
  room,
  rooms,
  editDisabled,
  onEdit,
}: {
  room: RoomAuthoringDraft;
  rooms: RoomAuthoringDraft[];
  editDisabled: boolean;
  onEdit: () => void;
}) {
  const summary = roomMissingSummary(validateRoomDraft(room, rooms));
  const cover = room.photos.find(({ uploadState }) => uploadState === "ready");
  return (
    <article className="grid grid-cols-[4.5rem_1fr] gap-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:items-center">
      <PhotoPreview photo={cover} label={`${room.name || "Room"} cover`} />
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold text-gray-950">
          {room.name || "Unnamed room type"}
        </h3>
        <p className="mt-1 text-sm text-gray-600">
          {room.unitCount || "0"} rooms · Up to {room.maxGuests || "0"} guests
        </p>
        <p
          className={`mt-1 text-xs font-medium ${summary.startsWith("Room details") ? "text-emerald-700" : "text-amber-700"}`}
        >
          {summary}
        </p>
      </div>
      <button
        type="button"
        onClick={onEdit}
        disabled={editDisabled}
        title={editDisabled ? "Save or discard the room you are editing first." : undefined}
        className={`${secondaryButtonClass} col-span-2 justify-center disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-1`}
      >
        Edit
      </button>
    </article>
  );
}

function PhotoGrid({
  photos,
  compact = false,
  onMove,
  onRemove,
  onRetry,
}: {
  photos: RoomPhotoDraft[];
  compact?: boolean;
  onMove?: (index: number, direction: -1 | 1) => void;
  onRemove?: (index: number) => void;
  onRetry?: (photo: RoomPhotoDraft) => void;
}) {
  return (
    <div className={`mt-3 grid grid-cols-2 gap-3 ${compact ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
      {photos.map((photo, index) => (
        <div
          key={photo.mediaObjectId}
          className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50"
        >
          <div className="relative aspect-[4/3]">
            <PhotoPreview photo={photo} label={`Room photo ${index + 1}`} square />
            {index === 0 && (
              <span className="absolute left-2 top-2 rounded-full bg-gray-950/80 px-2 py-1 text-[10px] font-semibold text-white">
                Cover
              </span>
            )}
          </div>
          {!compact && (
            <div className="grid grid-cols-3 border-t border-gray-200 bg-white">
              <button
                type="button"
                onClick={() => onMove?.(index, -1)}
                disabled={index === 0}
                aria-label={`Move photo ${index + 1} left`}
                className={photoActionClass}
              >
                <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onMove?.(index, 1)}
                disabled={index === photos.length - 1}
                aria-label={`Move photo ${index + 1} right`}
                className={photoActionClass}
              >
                <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onRemove?.(index)}
                aria-label={`Remove photo ${index + 1}`}
                className={`${photoActionClass} hover:text-red-700`}
              >
                <TrashIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          )}
          {photo.uploadState === "failed" && !compact && (
            <button
              type="button"
              onClick={() => onRetry?.(photo)}
              className="min-h-10 w-full border-t border-red-200 px-2 text-xs font-semibold text-red-700"
            >
              Retry upload
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function PhotoPreview({
  photo,
  label,
  square = false,
}: {
  photo?: RoomPhotoDraft;
  label: string;
  square?: boolean;
}) {
  if (!photo?.previewUrl) {
    return (
      <div
        className={`flex w-full items-center justify-center bg-gray-100 text-gray-400 ${square ? "h-full" : "aspect-square rounded-xl"}`}
        aria-label={label}
        role="img"
      >
        <PhotoIcon className="h-6 w-6" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div
      className={`w-full bg-cover bg-center ${square ? "h-full" : "aspect-square rounded-xl"} ${photo.uploadState === "uploading" ? "animate-pulse opacity-60" : ""}`}
      style={{ backgroundImage: `url(${JSON.stringify(photo.previewUrl)})` }}
      aria-label={
        photo.uploadState === "uploading"
          ? `${label}, uploading`
          : photo.uploadState === "failed"
            ? `${label}, upload failed`
            : label
      }
      role="img"
    />
  );
}

function AccessibleDialog({
  title,
  children,
  onClose,
  returnFocusRef,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = `dialog-${useMemo(() => crypto.randomUUID(), [])}`;
  useEffect(() => {
    const returnTarget = returnFocusRef?.current ?? (document.activeElement as HTMLElement | null);
    const dialog = dialogRef.current;
    const first = focusable(dialog)[0];
    (first ?? dialog)?.focus();
    return () => returnTarget?.focus();
  }, [returnFocusRef]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable(dialogRef.current);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-gray-950/45 sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="max-h-[100dvh] min-h-[100dvh] w-full overflow-y-auto bg-white p-5 outline-none sm:min-h-0 sm:max-h-[85dvh] sm:max-w-2xl sm:rounded-2xl sm:p-7"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 pb-4">
          <h2 id={titleId} className="text-lg font-semibold text-gray-950">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-500 outline-none hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-primary-600"
          >
            <XMarkIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="pt-5">{children}</div>
      </div>
    </div>
  );
}

function RecoveryBanner({
  title,
  message,
  actionLabel,
  onAction,
  tone,
}: {
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
  tone: "warning" | "danger";
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-4 ${tone === "danger" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}
      role="status"
    >
      <div className="flex items-start gap-3">
        <ExclamationTriangleIcon
          className={`mt-0.5 h-5 w-5 shrink-0 ${tone === "danger" ? "text-red-700" : "text-amber-700"}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-gray-950">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-gray-700">{message}</p>
          <button type="button" onClick={onAction} className={`${secondaryButtonClass} mt-3`}>
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  help,
  required = false,
  type = "text",
  ...inputProps
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  help?: string;
  required?: boolean;
  type?: "text" | "number";
  maxLength?: number;
  min?: string;
  max?: string;
  step?: string;
  inputMode?: "numeric" | "decimal";
  placeholder?: string;
}) {
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={labelClass}>
        {label} {required && <Required />}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={[helpId, errorId].filter(Boolean).join(" ") || undefined}
        className={inputClass(Boolean(error))}
        {...inputProps}
      />
      {help && (
        <p id={helpId} className="mt-1 text-xs leading-5 text-gray-500">
          {help}
        </p>
      )}
      <FieldError id={errorId ?? `${id}-error`} message={error} />
    </div>
  );
}

function Required() {
  return (
    <span className="text-red-600" aria-hidden="true">
      *
    </span>
  );
}
function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="mt-1 text-xs font-medium text-red-700">
      {message}
    </p>
  ) : null;
}

function roomCoreValidationErrors(
  room: RoomAuthoringDraft,
  rooms: readonly RoomAuthoringDraft[],
): RoomValidationErrors {
  const errors = validateRoomDraft(room, rooms);
  delete errors.photos;
  delete errors.amenities;
  return errors;
}

function focusFirstError(room: RoomAuthoringDraft, errors: RoomValidationErrors) {
  const order = [
    "name",
    "unitCount",
    "maxGuests",
    "bathroomType",
    ...Object.keys(errors).filter((key) => key.startsWith("bed")),
    "description",
    "photos",
    "amenities",
    "maxAdults",
    "maxChildren",
    "bedrooms",
    "bathrooms",
    "sizeSquareMetres",
  ];
  const first = order.find((key) => errors[key]);
  if (!first) return;
  const normalized = first.replace(".", "-");
  requestAnimationFrame(() =>
    document.getElementById(`${room.draftRoomId}-${normalized}`)?.focus(),
  );
}

function focusable(root: HTMLElement | null): HTMLElement[] {
  return root
    ? Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((item) => item.offsetParent !== null)
    : [];
}

function errorMessage(error: unknown): string {
  if (error instanceof RoomDraftManifestUnavailableError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "This room could not be saved. Try again.";
}

const labelClass = "block text-sm font-semibold text-gray-900";
const primaryButtonClass =
  "inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-full bg-primary-600 px-5 text-sm font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-primary-300";
const secondaryButtonClass =
  "inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-full border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const photoActionClass =
  "inline-flex min-h-10 items-center justify-center text-gray-600 outline-none hover:bg-gray-50 hover:text-gray-950 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-not-allowed disabled:opacity-30";
function inputClass(error: boolean) {
  return `mt-2 min-h-11 w-full rounded-xl border bg-white px-3 py-2 text-sm text-gray-950 outline-none placeholder:text-gray-400 focus:ring-2 focus:ring-primary-600 focus:ring-offset-1 ${error ? "border-red-500" : "border-gray-300"}`;
}
