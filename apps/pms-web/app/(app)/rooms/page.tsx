"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import {
  PlusIcon,
  MagnifyingGlassIcon,
  ChevronDownIcon,
  Cog6ToothIcon,
  DocumentDuplicateIcon,
  PencilIcon,
  CheckIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  roomsService,
  individualRoomsService,
  linkedInventoryGroupsService,
  type LinkedInventoryGroup,
  type RoomType,
  type Room,
} from "@/services/rooms";
import ConfirmDialog from "@/components/ConfirmDialog";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";
import { imageReferenceUrl } from "@/services/upload";
import LinkedInventoryGroupsPanel from "./LinkedInventoryGroupsPanel";

const CATEGORY_STYLES: Record<string, string> = {
  suite: "bg-blue-50 text-blue-600 border border-blue-200",
  villa: "bg-green-50 text-green-600 border border-green-200",
  standard: "bg-gray-50 text-gray-600 border border-gray-200",
  deluxe: "bg-purple-50 text-purple-600 border border-purple-200",
  bungalow: "bg-amber-50 text-amber-600 border border-amber-200",
  residence: "bg-teal-50 text-teal-600 border border-teal-200",
};

function getCategoryFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("suite")) return "suite";
  if (lower.includes("villa")) return "villa";
  if (lower.includes("deluxe")) return "deluxe";
  if (lower.includes("bungalow")) return "bungalow";
  if (lower.includes("residence")) return "residence";
  return "standard";
}

function getCategoryLabel(name: string): string {
  const cat = getCategoryFromName(name);
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

interface RateOverview {
  flexMin: number;
  flexMax: number;
  nrMin: number | null;
  nrMax: number | null;
  seasonCount: number;
  discountPct: number;
}

function getRateOverview(room: RoomType): RateOverview | null {
  const seasonRates = (room.seasons || [])
    .map((s) => parseFloat(s.rate))
    .filter((n) => Number.isFinite(n) && n > 0);
  const monthlyBaseRates = Object.values(room.monthlyRates || {})
    .map((m) => (typeof m?.baseRate === "number" ? m.baseRate : null))
    .filter((n): n is number => n != null && n > 0);
  const dailyRateValues = Object.values(room.dailyRates || {}).filter(
    (n): n is number => typeof n === "number" && n > 0,
  );

  const hasBaseRate = typeof room.baseRate === "number" && room.baseRate > 0;
  const flexValues = [
    ...(hasBaseRate ? [room.baseRate] : []),
    ...seasonRates,
    ...monthlyBaseRates,
    ...dailyRateValues,
  ];
  if (flexValues.length === 0) return null;

  const flexMin = Math.min(...flexValues);
  const flexMax = Math.max(...flexValues);
  const referenceRate = hasBaseRate
    ? room.baseRate
    : (seasonRates[0] ?? monthlyBaseRates[0] ?? dailyRateValues[0]);

  let nrMin: number | null = null;
  let nrMax: number | null = null;
  let discountPct = 0;

  if (room.nonRefundableEnabled !== false) {
    if (room.nonRefundableDiscount && room.nonRefundableDiscount > 0) {
      const factor = 1 - room.nonRefundableDiscount / 100;
      discountPct = Math.round(room.nonRefundableDiscount);
      nrMin = Math.round(flexMin * factor);
      nrMax = Math.round(flexMax * factor);
    } else if (room.nonRefundableRate && room.nonRefundableRate > 0 && referenceRate > 0) {
      const factor = room.nonRefundableRate / referenceRate;
      discountPct = Math.round((1 - factor) * 100);
      nrMin = Math.round(flexMin * factor);
      nrMax = Math.round(flexMax * factor);
    }
  }

  return {
    flexMin,
    flexMax,
    nrMin,
    nrMax,
    seasonCount: seasonRates.length,
    discountPct,
  };
}

function formatRateRange(min: number, max: number, currency: string): string {
  if (min === max) return formatCurrency(min, currency);
  return `${formatCurrency(min, currency)}–${formatCurrency(max, currency).replace(/^[^0-9]+/, "")}`;
}

const ROOM_UNIT_COMMANDS_UNSUPPORTED_MESSAGE =
  "Individual room create, edit, and delete are not available on PMS next-stack yet.";

function RoomTypeCard({
  room,
  rooms,
  onRoomsChange,
  onDuplicate,
  duplicating,
  linkedGroup,
}: {
  room: RoomType;
  rooms: Room[];
  onRoomsChange: () => void;
  onDuplicate: (id: string) => Promise<void>;
  duplicating: boolean;
  linkedGroup?: LinkedInventoryGroup;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [addingRoom, setAddingRoom] = useState(false);
  const [newRoomNumber, setNewRoomNumber] = useState("");
  const [newRoomFloor, setNewRoomFloor] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [editingRoomNumber, setEditingRoomNumber] = useState("");
  const category = room.category ? room.category.toLowerCase() : getCategoryFromName(room.name);
  const categoryStyle = CATEGORY_STYLES[category] || CATEGORY_STYLES["standard"];

  const typeRooms = rooms.filter((r) => r.roomTypeId === room.id);
  const available = typeRooms.filter((r) => r.status === "available").length;
  const rateOverview = getRateOverview(room);
  const thumbnailUrl = imageReferenceUrl(room.images?.[0]);

  const handleAddRoom = async () => {
    if (!newRoomNumber.trim()) return;
    try {
      await individualRoomsService.create({
        roomTypeId: room.id,
        roomNumber: newRoomNumber.trim(),
        floor: newRoomFloor.trim(),
      });
      setNewRoomNumber("");
      setNewRoomFloor("");
      setAddingRoom(false);
      onRoomsChange();
    } catch (err: any) {
      alert(err.message || t("rooms.failedToAddRoom"));
    }
  };

  const handleDeleteRoom = (roomId: string) => {
    setConfirmDelete(roomId);
  };

  const doDeleteRoom = async () => {
    if (!confirmDelete) return;
    setConfirmDelete(null);
    try {
      await individualRoomsService.delete(confirmDelete);
      onRoomsChange();
    } catch (err: any) {
      alert(err.message || t("rooms.cannotDeleteRoom"));
    }
  };

  const startRenameRoom = (roomId: string, currentNumber: string) => {
    setEditingRoomId(roomId);
    setEditingRoomNumber(currentNumber);
  };

  const cancelRenameRoom = () => {
    setEditingRoomId(null);
    setEditingRoomNumber("");
  };

  const saveRenameRoom = async (roomId: string, currentNumber: string) => {
    const trimmed = editingRoomNumber.trim();
    if (!trimmed || trimmed === currentNumber) {
      cancelRenameRoom();
      return;
    }
    try {
      await individualRoomsService.update(roomId, { roomNumber: trimmed });
      cancelRenameRoom();
      onRoomsChange();
    } catch (err: any) {
      alert(err.message || t("rooms.failedToRenameRoom"));
    }
  };

  const handleStatusChange = async (roomId: string, status: string) => {
    try {
      await individualRoomsService.update(roomId, { status });
      onRoomsChange();
    } catch {
      // ignore
    }
  };

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      {/* Room Type Header Row */}
      <div
        className="flex items-center px-3 md:px-5 py-3 md:py-4 gap-2 md:gap-3 hover:bg-gray-50/50 transition-colors cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Expand arrow */}
        <ChevronDownIcon
          className={`w-4 h-4 text-gray-400 transition-transform shrink-0 ${expanded ? "" : "-rotate-90"}`}
        />

        {/* Room type thumbnail or fallback icon */}
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={room.name}
            className="w-9 h-9 md:w-10 md:h-10 rounded-xl object-cover shrink-0"
          />
        ) : (
          <div className="w-9 h-9 md:w-10 md:h-10 bg-blue-50 rounded-xl flex items-center justify-center shrink-0">
            <svg
              className="w-4 h-4 md:w-5 md:h-5 text-blue-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 21V7a2 2 0 0 1 2-2h6v16" />
              <path d="M13 21V3h6a2 2 0 0 1 2 2v16" />
              <path d="M3 21h18" />
              <path d="M7 9h2" />
              <path d="M7 13h2" />
              <path d="M15 9h2" />
              <path d="M15 13h2" />
            </svg>
          </div>
        )}

        {/* Name + info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-semibold text-gray-900 truncate">{room.name}</span>
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${categoryStyle}`}
            >
              {room.category || getCategoryLabel(room.name)}
            </span>
            {linkedGroup && (
              <span
                title={t("rooms.linkedInventoryNamed", { name: linkedGroup.name })}
                className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700"
              >
                {t("rooms.linked")}
              </span>
            )}
          </div>
          <p className="text-[12px] text-gray-400 mt-0.5 truncate">
            {typeRooms.length} {t(typeRooms.length === 1 ? "common.room" : "common.rooms")}
            {room.maxOccupancy > 0 && (
              <>
                {" "}
                &middot; {room.maxOccupancy} {t("rooms.occ")}
              </>
            )}
            {room.size > 0 && <> &middot; {room.size}m&sup2;</>}
          </p>
        </div>

        {/* Rate overview (md+) */}
        {rateOverview && (
          <div className="hidden md:flex flex-col gap-1 shrink-0 mr-2 text-[12px]">
            <div className="flex items-center gap-2">
              <span className="text-gray-500">{t("rooms.flexRate")}</span>
              <span className="font-medium text-gray-800 tabular-nums">
                {formatRateRange(rateOverview.flexMin, rateOverview.flexMax, room.currency)}
              </span>
              {rateOverview.seasonCount > 0 && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-50 border border-gray-200 text-gray-600">
                  {rateOverview.seasonCount}{" "}
                  {rateOverview.seasonCount === 1 ? t("rooms.season") : t("rooms.seasons")}
                </span>
              )}
            </div>
            {rateOverview.nrMin != null && rateOverview.nrMax != null && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500">{t("rooms.nonRefundableShort")}</span>
                <span className="font-medium text-gray-800 tabular-nums">
                  {formatRateRange(rateOverview.nrMin, rateOverview.nrMax, room.currency)}
                </span>
                {rateOverview.discountPct > 0 && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-700">
                    -{rateOverview.discountPct}%
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Count badge */}
        <span
          className={`shrink-0 w-6 h-6 rounded-full text-white text-[11px] font-bold flex items-center justify-center ${typeRooms.length > 0 ? "bg-green-500" : "bg-gray-300"}`}
          title={t("rooms.availableCount", { count: available })}
        >
          {typeRooms.length}
        </span>

        {/* Duplicate + Configure buttons */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            void onDuplicate(room.id);
          }}
          disabled={duplicating}
          className="flex items-center justify-center w-8 h-8 md:w-auto md:h-auto md:px-3 md:py-1.5 text-[12px] font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          title={duplicating ? t("rooms.duplicatingRoomType") : t("rooms.duplicateRoomType")}
          aria-label={duplicating ? t("rooms.duplicatingRoomType") : t("rooms.duplicateRoomType")}
        >
          <DocumentDuplicateIcon className="w-3.5 h-3.5" />
        </button>
        <Link
          href={`/rooms/${room.id}`}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center justify-center gap-1.5 w-8 h-8 md:w-auto md:h-auto md:px-3 md:py-1.5 text-[12px] font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors shrink-0"
          title={t("rooms.configure")}
        >
          <Cog6ToothIcon className="w-3.5 h-3.5" />
          <span className="hidden md:inline">{t("rooms.configure")}</span>
        </Link>
      </div>

      {/* Expanded: Derived Rates + Individual Rooms */}
      {expanded && (
        <div className="pl-5 md:pl-16 pr-3 md:pr-5 pb-4">
          {/* Mobile rate overview (header version is hidden < md) */}
          {rateOverview && (
            <div className="md:hidden flex flex-col gap-1 mb-3 text-[12px]">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-gray-500">{t("rooms.flexRate")}</span>
                <span className="font-medium text-gray-800 tabular-nums">
                  {formatRateRange(rateOverview.flexMin, rateOverview.flexMax, room.currency)}
                </span>
                {rateOverview.seasonCount > 0 && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-50 border border-gray-200 text-gray-600">
                    {rateOverview.seasonCount}{" "}
                    {rateOverview.seasonCount === 1 ? t("rooms.season") : t("rooms.seasons")}
                  </span>
                )}
              </div>
              {rateOverview.nrMin != null && rateOverview.nrMax != null && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-gray-500">{t("rooms.nonRefundableShort")}</span>
                  <span className="font-medium text-gray-800 tabular-nums">
                    {formatRateRange(rateOverview.nrMin, rateOverview.nrMax, room.currency)}
                  </span>
                  {rateOverview.discountPct > 0 && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-700">
                      -{rateOverview.discountPct}%
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Individual rooms */}
          {typeRooms.length > 0 ? (
            typeRooms.map((r) => {
              const statusStyles: Record<string, string> = {
                available: "bg-green-50 text-green-600 border-green-200",
                maintenance: "bg-amber-50 text-amber-600 border-amber-200",
                out_of_order: "bg-red-50 text-red-600 border-red-200",
              };
              const isEditing = editingRoomId === r.id;
              return (
                <div
                  key={r.id}
                  className="flex items-center py-2.5 border-l-2 border-gray-200 pl-4 ml-1 hover:border-primary-400 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] text-gray-400">#</span>
                        <input
                          type="text"
                          autoFocus
                          value={editingRoomNumber}
                          onChange={(e) => setEditingRoomNumber(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveRenameRoom(r.id, r.roomNumber);
                            else if (e.key === "Escape") cancelRenameRoom();
                          }}
                          className="text-[13px] font-medium text-gray-800 px-2 py-1 border border-primary-300 rounded-md focus:outline-none focus:border-primary-500 min-w-0 w-40"
                        />
                        {r.floor && (
                          <span className="text-gray-400 text-[11px]">
                            {t("rooms.floorNumber", { floor: r.floor })}
                          </span>
                        )}
                      </div>
                    ) : (
                      <p className="text-[13px] font-medium text-gray-800">
                        #{r.roomNumber}
                        {r.floor && (
                          <span className="text-gray-400 ml-1.5 text-[11px]">
                            {t("rooms.floorNumber", { floor: r.floor })}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  {isEditing ? (
                    <>
                      <button
                        onClick={() => saveRenameRoom(r.id, r.roomNumber)}
                        className="p-1 text-green-500 hover:text-green-600 transition-colors"
                        title={t("rooms.saveRename")}
                      >
                        <CheckIcon className="w-4 h-4" />
                      </button>
                      <button
                        onClick={cancelRenameRoom}
                        className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                        title={t("rooms.cancelRename")}
                      >
                        <XMarkIcon className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <select
                        value={r.status}
                        onChange={(e) => handleStatusChange(r.id, e.target.value)}
                        disabled
                        title={ROOM_UNIT_COMMANDS_UNSUPPORTED_MESSAGE}
                        className={`text-[11px] font-medium px-2.5 py-1 rounded-full border appearance-none cursor-pointer mr-2 disabled:cursor-not-allowed ${statusStyles[r.status] || statusStyles.available}`}
                      >
                        <option value="available">{t("rooms.statusAvailable")}</option>
                        <option value="maintenance">{t("rooms.statusMaintenance")}</option>
                        <option value="out_of_order">{t("rooms.statusOutOfOrder")}</option>
                      </select>
                      <button
                        onClick={() => startRenameRoom(r.id, r.roomNumber)}
                        disabled
                        className="p-1 text-gray-300 hover:text-primary-500 transition-colors disabled:cursor-not-allowed"
                        title={ROOM_UNIT_COMMANDS_UNSUPPORTED_MESSAGE}
                      >
                        <PencilIcon className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteRoom(r.id)}
                        disabled
                        className="p-1 text-gray-300 hover:text-red-500 transition-colors disabled:cursor-not-allowed"
                        title={ROOM_UNIT_COMMANDS_UNSUPPORTED_MESSAGE}
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              );
            })
          ) : (
            <p className="text-[12px] text-gray-400 py-2">{t("rooms.noRoomsYet")}</p>
          )}

          {/* Add room form */}
          {addingRoom ? (
            <div className="flex flex-wrap items-center gap-2 mt-2 pl-4 ml-1 border-l-2 border-primary-300 py-2">
              <input
                type="text"
                value={newRoomNumber}
                onChange={(e) => setNewRoomNumber(e.target.value)}
                placeholder={t("rooms.roomNumberPlaceholder")}
                className="flex-1 min-w-[120px] md:flex-initial md:w-32 px-2.5 py-1.5 text-[12px] border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleAddRoom()}
              />
              <input
                type="text"
                value={newRoomFloor}
                onChange={(e) => setNewRoomFloor(e.target.value)}
                placeholder={t("rooms.floorPlaceholder")}
                className="w-20 px-2.5 py-1.5 text-[12px] border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                onKeyDown={(e) => e.key === "Enter" && handleAddRoom()}
              />
              <button
                onClick={handleAddRoom}
                className="px-3 py-1.5 text-[11px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
              >
                {t("common.add")}
              </button>
              <button
                onClick={() => {
                  setAddingRoom(false);
                  setNewRoomNumber("");
                  setNewRoomFloor("");
                }}
                className="px-2 py-1.5 text-[11px] text-gray-500 hover:text-gray-700"
              >
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAddingRoom(true)}
              disabled
              title={ROOM_UNIT_COMMANDS_UNSUPPORTED_MESSAGE}
              className="mt-2 ml-5 inline-flex items-center gap-1.5 text-[11px] text-gray-500 font-medium hover:text-primary-600 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlusIcon className="w-3.5 h-3.5" /> {t("rooms.addRoom")}
            </button>
          )}
        </div>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t("rooms.deleteRoom")}
          message={t("rooms.deleteRoomConfirm")}
          confirmLabel={t("rooms.deleteRoom")}
          variant="danger"
          onConfirm={doDeleteRoom}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

export default function RoomsPage() {
  const { t } = useTranslation();
  const [rooms, setRooms] = useState<RoomType[]>([]);
  const [individualRooms, setIndividualRooms] = useState<Room[]>([]);
  const [linkedGroups, setLinkedGroups] = useState<LinkedInventoryGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [duplicatingRoomTypeIds, setDuplicatingRoomTypeIds] = useState<Set<string>>(new Set());

  const loadData = () => {
    Promise.allSettled([
      roomsService.list(),
      individualRoomsService.list(),
      linkedInventoryGroupsService.list(),
    ])
      .then(([types, indRooms, groups]) => {
        if (types.status === "fulfilled") setRooms(types.value);
        else console.error(types.reason);
        if (indRooms.status === "fulfilled") setIndividualRooms(indRooms.value);
        else console.error(indRooms.reason);
        if (groups.status === "fulfilled") setLinkedGroups(groups.value);
        else console.error(groups.reason);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadData();
  }, []);

  const refreshRooms = () => {
    individualRoomsService.list().then(setIndividualRooms).catch(console.error);
  };

  const handleDuplicate = async (id: string) => {
    setDuplicatingRoomTypeIds((current) => new Set(current).add(id));
    try {
      await roomsService.duplicate(id);
      loadData();
    } catch (err: any) {
      alert(err.message || t("rooms.failedToDuplicate"));
    } finally {
      setDuplicatingRoomTypeIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const filteredRooms = useMemo(() => {
    if (!searchQuery.trim()) return rooms;
    const q = searchQuery.toLowerCase();
    return rooms.filter((r) => r.name.toLowerCase().includes(q));
  }, [rooms, searchQuery]);

  return (
    <div className="p-4 md:p-6 pb-0">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-5 md:mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl md:text-xl font-bold text-gray-900">{t("rooms.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("rooms.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          <Link
            href="/rooms/new"
            className="inline-flex items-center gap-1.5 px-3 md:px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors"
          >
            <PlusIcon className="w-4 h-4" />
            <span className="hidden md:inline">{t("rooms.addRoomType")}</span>
            <span className="md:hidden">{t("common.add")}</span>
          </Link>
        </div>
      </div>

      {/* Search */}
      <div className="mb-4 md:mb-5">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder={t("rooms.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full md:w-72 pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
          />
        </div>
      </div>

      {!loading && linkedGroups && (
        <LinkedInventoryGroupsPanel
          groups={linkedGroups}
          roomTypes={rooms}
          onChange={(update) => setLinkedGroups((groups) => (groups ? update(groups) : groups))}
        />
      )}

      {/* Room Type List */}
      {loading ? (
        <div className="animate-pulse space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-20 bg-gray-50 rounded-xl" />
          ))}
        </div>
      ) : filteredRooms.length === 0 && rooms.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-16 text-center">
          <div className="w-14 h-14 bg-gray-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-7 h-7 text-gray-300"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 21V7a2 2 0 0 1 2-2h6v16" />
              <path d="M13 21V3h6a2 2 0 0 1 2 2v16" />
              <path d="M3 21h18" />
            </svg>
          </div>
          <p className="text-gray-500 text-sm mb-4">{t("rooms.noRoomTypes")}</p>
          <Link
            href="/rooms/new"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
          >
            <PlusIcon className="w-4 h-4" />
            {t("rooms.addRoomType")}
          </Link>
        </div>
      ) : filteredRooms.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-sm text-gray-400">{t("rooms.noSearchResults")}</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          {filteredRooms.map((room) => (
            <RoomTypeCard
              key={room.id}
              room={room}
              rooms={individualRooms}
              onRoomsChange={refreshRooms}
              onDuplicate={handleDuplicate}
              duplicating={duplicatingRoomTypeIds.has(room.id)}
              linkedGroup={linkedGroups?.find((group) => group.memberRoomTypeIds.includes(room.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
