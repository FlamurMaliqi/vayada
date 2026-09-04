"use client";

import { useState } from "react";
import { PencilIcon, PlusIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
  linkedInventoryGroupsService,
  type LinkedInventoryGroup,
  type RoomType,
} from "@/services/rooms";
import { useTranslation } from "@/lib/i18n";

type Draft = {
  groupId?: string;
  revision?: number;
  name: string;
  memberRoomTypeIds: string[];
};

export default function LinkedInventoryGroupsPanel({
  groups,
  roomTypes,
  onChange,
}: {
  groups: LinkedInventoryGroup[];
  roomTypes: RoomType[];
  onChange: (update: (groups: LinkedInventoryGroup[]) => LinkedInventoryGroup[]) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const edit = (group?: LinkedInventoryGroup) => {
    if (saving) return;
    setError("");
    setDraft(group ? { ...group } : { name: "", memberRoomTypeIds: [] });
  };

  const toggleMember = (roomTypeId: string) => {
    if (!draft || saving) return;
    setDraft({
      ...draft,
      memberRoomTypeIds: draft.memberRoomTypeIds.includes(roomTypeId)
        ? draft.memberRoomTypeIds.filter((id) => id !== roomTypeId)
        : [...draft.memberRoomTypeIds, roomTypeId],
    });
  };

  const save = async () => {
    if (saving) return;
    if (!draft || !draft.name.trim() || draft.memberRoomTypeIds.length < 2) {
      setError(t("rooms.linkedValidation"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      let saved: LinkedInventoryGroup;
      if (draft.groupId && draft.revision !== undefined) {
        saved = await linkedInventoryGroupsService.update({
          groupId: draft.groupId,
          revision: draft.revision,
          name: draft.name.trim(),
          memberRoomTypeIds: draft.memberRoomTypeIds,
        });
      } else {
        saved = await linkedInventoryGroupsService.create(
          draft.name.trim(),
          draft.memberRoomTypeIds,
        );
      }
      setDraft(null);
      onChange((current) =>
        current.some((group) => group.groupId === saved.groupId)
          ? current.map((group) => (group.groupId === saved.groupId ? saved : group))
          : [...current, saved],
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("rooms.linkedSaveError"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (group: LinkedInventoryGroup) => {
    if (saving) return;
    if (!window.confirm(t("rooms.linkedDeleteConfirm", { name: group.name }))) return;
    setSaving(true);
    setError("");
    try {
      await linkedInventoryGroupsService.delete(group);
      onChange((current) => current.filter((candidate) => candidate.groupId !== group.groupId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("rooms.linkedDeleteError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-5 rounded-xl border border-gray-200 bg-white p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">{t("rooms.linkedInventory")}</h2>
          <p className="mt-1 text-xs text-gray-500">{t("rooms.linkedInventoryDescription")}</p>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => edit()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
        >
          <PlusIcon className="h-4 w-4" /> {t("rooms.linkedAddGroup")}
        </button>
      </div>

      {groups.length > 0 && (
        <div className="mt-4 divide-y divide-gray-100 border-t border-gray-100">
          {groups.map((group) => (
            <div key={group.groupId} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900">{group.name}</p>
                <p className="truncate text-xs text-gray-500">
                  {group.memberRoomTypeIds
                    .map((id) => roomTypes.find((roomType) => roomType.id === id)?.name ?? id)
                    .join(" · ")}
                </p>
              </div>
              <button
                type="button"
                disabled={saving}
                aria-label={t("rooms.linkedEditNamed", { name: group.name })}
                onClick={() => edit(group)}
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-50 hover:text-gray-700"
              >
                <PencilIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={saving}
                aria-label={t("rooms.linkedDeleteNamed", { name: group.name })}
                onClick={() => remove(group)}
                className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="mt-4 rounded-lg border border-primary-200 bg-primary-50/30 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">
              {draft.groupId ? t("rooms.linkedEditGroup") : t("rooms.linkedNewGroup")}
            </h3>
            <button type="button" aria-label={t("common.close")} onClick={() => setDraft(null)}>
              <XMarkIcon className="h-4 w-4 text-gray-500" />
            </button>
          </div>
          <label className="mt-3 block text-xs font-medium text-gray-700">
            {t("rooms.linkedGroupName")}
            <input
              autoFocus
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
            />
          </label>
          <fieldset className="mt-3 grid gap-2 sm:grid-cols-2">
            <legend className="mb-2 text-xs font-medium text-gray-700">
              {t("rooms.roomTypes")}
            </legend>
            {roomTypes.map((roomType) => {
              const selected = draft.memberRoomTypeIds.includes(roomType.id);
              const unavailable =
                !selected &&
                groups.some(
                  (group) =>
                    group.groupId !== draft.groupId &&
                    group.memberRoomTypeIds.includes(roomType.id),
                );
              return (
                <label
                  key={roomType.id}
                  className={`flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-xs ${unavailable ? "cursor-not-allowed text-gray-400" : "cursor-pointer text-gray-700"}`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={unavailable}
                    onChange={() => toggleMember(roomType.id)}
                  />
                  {roomType.name}
                </label>
              );
            })}
          </fieldset>
          {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-lg px-3 py-2 text-xs font-semibold text-gray-600"
            >
              {t("rooms.cancelRename")}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={save}
              className="rounded-lg bg-primary-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {saving ? t("common.saving") : t("rooms.linkedSaveGroup")}
            </button>
          </div>
        </div>
      )}
      {!draft && error && <p className="mt-3 text-xs text-red-600">{error}</p>}
    </section>
  );
}
