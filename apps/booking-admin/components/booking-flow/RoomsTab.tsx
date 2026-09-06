"use client";
import { useTranslation } from "@/lib/i18n";

import { useState } from "react";
import { XMarkIcon, PencilIcon } from "@heroicons/react/24/outline";
import { AVAILABLE_FILTERS } from "@/lib/constants/filters";

interface RoomOption {
  id: string;
  name: string;
}

interface RoomsTabProps {
  bookingFilters: string[];
  setBookingFilters: (v: string[] | ((prev: string[]) => string[])) => void;
  customFilters: Record<string, string>;
  setCustomFilters: (
    v: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;
  filterRooms: Record<string, string[]>;
  setFilterRooms: (
    v: Record<string, string[]> | ((prev: Record<string, string[]>) => Record<string, string[]>),
  ) => void;
  filtersEnabled: boolean;
  onToggleFiltersEnabled: () => void;
  handleSaveFilters: () => void;
  savingFilters: boolean;
  rooms: RoomOption[];
  roomsLoading: boolean;
}

function DragIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="9" cy="6" r="1.5" />
      <circle cx="15" cy="6" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
      <circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="18" r="1.5" />
      <circle cx="15" cy="18" r="1.5" />
    </svg>
  );
}

export default function RoomsTab({
  bookingFilters,
  setBookingFilters,
  customFilters,
  setCustomFilters,
  filterRooms,
  setFilterRooms,
  filtersEnabled,
  onToggleFiltersEnabled,
  handleSaveFilters,
  savingFilters,
  rooms,
  roomsLoading,
}: RoomsTabProps) {
  const { t } = useTranslation();
  const [showAddFilter, setShowAddFilter] = useState(false);
  const [selectedFilterKey, setSelectedFilterKey] = useState("");
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [editingFilterKey, setEditingFilterKey] = useState<string | null>(null);
  const [customFilterName, setCustomFilterName] = useState("");
  const [showCustomInput, setShowCustomInput] = useState(false);

  // All filter options: built-in + custom
  const allFilterOptions = [
    ...AVAILABLE_FILTERS.map((f) => ({ key: f.key, label: t(`roomFilters.${f.key}`) })),
    ...Object.entries(customFilters).map(([key, label]) => ({ key, label })),
  ];

  // Filters that are already added (have room assignments)
  const addedFilters = bookingFilters
    .filter((key) => filterRooms[key] && filterRooms[key].length > 0)
    .map((key) => {
      const opt = allFilterOptions.find((f) => f.key === key);
      return { key, label: opt?.label || key, roomIds: filterRooms[key] || [] };
    });

  // Filters available to add (not yet assigned rooms)
  const availableToAdd = allFilterOptions.filter(
    (f) => !filterRooms[f.key] || filterRooms[f.key].length === 0,
  );

  const getRoomName = (roomId: string) => {
    const room = rooms.find((r) => r.id === roomId);
    return room?.name || roomId;
  };

  const handleAddFilter = () => {
    const filterKey = showCustomInput
      ? customFilterName.trim().replace(/\s+/g, "_").toLowerCase()
      : selectedFilterKey;
    const filterLabel = showCustomInput ? customFilterName.trim() : "";
    if (!filterKey || selectedRoomIds.length === 0) return;

    // Register custom filter label
    if (showCustomInput && filterLabel) {
      setCustomFilters((prev: Record<string, string>) => ({
        ...prev,
        [filterKey]: filterLabel,
      }));
    }

    // Add to bookingFilters if not already present
    setBookingFilters((prev: string[]) => (prev.includes(filterKey) ? prev : [...prev, filterKey]));

    // Set room assignments
    setFilterRooms((prev: Record<string, string[]>) => ({
      ...prev,
      [filterKey]: selectedRoomIds,
    }));

    // Reset form
    setSelectedFilterKey("");
    setSelectedRoomIds([]);
    setCustomFilterName("");
    setShowCustomInput(false);
    setShowAddFilter(false);
  };

  const handleEditFilter = (filterKey: string) => {
    setEditingFilterKey(filterKey);
    setSelectedFilterKey(filterKey);
    setSelectedRoomIds(filterRooms[filterKey] || []);
    setShowAddFilter(true);
  };

  const handleSaveEdit = () => {
    if (!editingFilterKey || selectedRoomIds.length === 0) return;

    setFilterRooms((prev: Record<string, string[]>) => ({
      ...prev,
      [editingFilterKey]: selectedRoomIds,
    }));

    setEditingFilterKey(null);
    setSelectedFilterKey("");
    setSelectedRoomIds([]);
    setShowAddFilter(false);
  };

  const handleRemoveFilter = (filterKey: string) => {
    setBookingFilters((prev: string[]) => prev.filter((k) => k !== filterKey));
    setFilterRooms((prev: Record<string, string[]>) => {
      const next = { ...prev };
      delete next[filterKey];
      return next;
    });
    // Also remove from custom filters if it's custom
    if (customFilters[filterKey]) {
      setCustomFilters((prev: Record<string, string>) => {
        const next = { ...prev };
        delete next[filterKey];
        return next;
      });
    }
  };

  const handleCancelAdd = () => {
    setShowAddFilter(false);
    setSelectedFilterKey("");
    setSelectedRoomIds([]);
    setEditingFilterKey(null);
    setCustomFilterName("");
    setShowCustomInput(false);
  };

  const toggleRoomSelection = (roomId: string) => {
    setSelectedRoomIds((prev) =>
      prev.includes(roomId) ? prev.filter((id) => id !== roomId) : [...prev, roomId],
    );
  };

  const selectAllRooms = () => setSelectedRoomIds(rooms.map((r) => r.id));
  const deselectAllRooms = () => setSelectedRoomIds([]);

  return (
    <div className="max-w-2xl space-y-4">
      {/* Room Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-start justify-between mb-1">
          <div>
            <h2 className="text-[14px] font-semibold text-gray-900">
              {t("bookingFlow.rooms.title")}
            </h2>
            <p className="text-[12px] text-gray-500 mt-0.5">{t("bookingFlow.rooms.subtitle")}</p>
          </div>
          <button
            type="button"
            onClick={onToggleFiltersEnabled}
            className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 mt-0.5 ${
              filtersEnabled ? "bg-primary-500" : "bg-gray-300"
            }`}
          >
            <span
              className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow transition-transform ${
                filtersEnabled ? "translate-x-[18px]" : ""
              }`}
            />
          </button>
        </div>

        {filtersEnabled && (
          <div className="mt-4">
            {/* Added filters list */}
            {addedFilters.length > 0 && (
              <div className="space-y-2 mb-4">
                {addedFilters.map((filter) => (
                  <div
                    key={filter.key}
                    className="flex items-center justify-between p-3 rounded-lg border border-gray-200 hover:border-gray-300 transition-all"
                  >
                    <div className="flex items-center gap-2.5">
                      <DragIcon className="w-4 h-4 text-gray-300" />
                      <div>
                        <span className="text-[13px] font-semibold text-gray-900">
                          {filter.label}
                        </span>
                        <span className="text-[12px] text-gray-400 ml-2">
                          {filter.roomIds.map((id) => getRoomName(id)).join(", ")}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleEditFilter(filter.key)}
                        className="text-[12px] text-gray-500 hover:text-primary-600 transition-colors"
                      >
                        {t("common.edit")}
                      </button>
                      <button
                        onClick={() => handleRemoveFilter(filter.key)}
                        className="w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title={t("admin.removeFilter")}
                      >
                        <XMarkIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Add Filter section */}
            {showAddFilter ? (
              <div className="border border-gray-200 rounded-lg p-4">
                <h3 className="text-[13px] font-semibold text-gray-900 mb-3">
                  {editingFilterKey
                    ? t("bookingFlow.rooms.editFilter")
                    : t("bookingFlow.rooms.addFilter")}
                </h3>

                {/* Filter name dropdown */}
                {!editingFilterKey && (
                  <div className="mb-4">
                    <label className="block text-[12px] font-medium text-gray-600 mb-1.5">
                      {t("bookingFlow.rooms.filterNameLabel")}
                    </label>
                    {showCustomInput ? (
                      <input
                        type="text"
                        value={customFilterName}
                        onChange={(e) => setCustomFilterName(e.target.value)}
                        placeholder={t("bookingFlow.rooms.enterCustomFilter")}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        autoFocus
                      />
                    ) : (
                      <select
                        value={selectedFilterKey}
                        onChange={(e) => {
                          if (e.target.value === "__custom__") {
                            setShowCustomInput(true);
                            setSelectedFilterKey("");
                          } else {
                            setSelectedFilterKey(e.target.value);
                          }
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white"
                      >
                        <option value="">{t("bookingFlow.rooms.selectFilter")}</option>
                        {availableToAdd.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                        <option value="__custom__">{t("bookingFlow.rooms.customFilter")}</option>
                      </select>
                    )}
                  </div>
                )}

                {editingFilterKey && (
                  <div className="mb-4">
                    <label className="block text-[12px] font-medium text-gray-600 mb-1.5">
                      {t("bookingFlow.rooms.filterNameLabel")}
                    </label>
                    <div className="px-3 py-2 border border-gray-200 rounded-lg text-[13px] bg-gray-50 text-gray-700">
                      {allFilterOptions.find((f) => f.key === editingFilterKey)?.label ||
                        editingFilterKey}
                    </div>
                  </div>
                )}

                {/* Room checkboxes */}
                {(selectedFilterKey ||
                  editingFilterKey ||
                  (showCustomInput && customFilterName.trim())) && (
                  <div>
                    <label className="block text-[12px] font-medium text-gray-600 mb-2">
                      {t("bookingFlow.rooms.whichRooms")}
                    </label>
                    {roomsLoading ? (
                      <div className="flex items-center gap-2 py-3">
                        <div className="w-4 h-4 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-[12px] text-gray-500">
                          {t("bookingFlow.rooms.loadingRooms")}
                        </span>
                      </div>
                    ) : rooms.length === 0 ? (
                      <p className="text-[12px] text-gray-400 py-2">
                        {t("bookingFlow.rooms.noRooms")}
                      </p>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          {rooms.map((room) => (
                            <label
                              key={room.id}
                              className="flex items-center gap-2 cursor-pointer py-1"
                            >
                              <input
                                type="checkbox"
                                checked={selectedRoomIds.includes(room.id)}
                                onChange={() => toggleRoomSelection(room.id)}
                                className="w-4 h-4 rounded border-gray-300 text-primary-500 focus:ring-primary-500"
                              />
                              <span className="text-[13px] text-gray-700">{room.name}</span>
                            </label>
                          ))}
                        </div>
                        <div className="flex items-center gap-3 mt-2">
                          <button
                            onClick={selectAllRooms}
                            className="text-[12px] text-primary-600 hover:text-primary-700 font-medium"
                          >
                            {t("bookingFlow.rooms.selectAll")}
                          </button>
                          <button
                            onClick={deselectAllRooms}
                            className="text-[12px] text-primary-600 hover:text-primary-700 font-medium"
                          >
                            {t("bookingFlow.rooms.deselectAll")}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-gray-100">
                  <button
                    onClick={handleCancelAdd}
                    className="px-3 py-1.5 text-[13px] font-medium text-gray-600 hover:text-gray-800 transition-colors"
                  >
                    {t("settings.totp.cancel")}
                  </button>
                  <button
                    onClick={editingFilterKey ? handleSaveEdit : handleAddFilter}
                    disabled={
                      (!selectedFilterKey &&
                        !editingFilterKey &&
                        !(showCustomInput && customFilterName.trim())) ||
                      selectedRoomIds.length === 0
                    }
                    className="px-4 py-1.5 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
                  >
                    {editingFilterKey ? t("common.save") : t("bookingFlow.rooms.addFilter")}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowAddFilter(true)}
                className="w-full py-2.5 border-2 border-dashed border-gray-300 rounded-lg text-[13px] font-medium text-gray-500 hover:border-gray-400 hover:text-gray-600 transition-colors"
              >
                {t("bookingFlow.rooms.addFilterButton")}
              </button>
            )}

            {/* Save button */}
            <button
              onClick={handleSaveFilters}
              disabled={savingFilters}
              className="mt-8 inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
            >
              {savingFilters ? (
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : null}
              {t("bookingFlow.rooms.saveFilters")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
