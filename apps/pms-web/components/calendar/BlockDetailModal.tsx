"use client";

import { useState } from "react";
import { CalendarBlock, CalendarRoomType } from "@/services/calendar";
import Modal from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";

interface BlockDetailModalProps {
  block: CalendarBlock;
  roomTypes: CalendarRoomType[];
  onSave: (updates: { startDate: string; endDate: string; reason: string }) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}

export default function BlockDetailModal({
  block,
  roomTypes,
  onSave,
  onDelete,
  onClose,
}: BlockDetailModalProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [startDate, setStartDate] = useState(block.startDate);
  const [endDate, setEndDate] = useState(block.endDate);
  const [reason, setReason] = useState(block.reason || "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const roomType = roomTypes.find((rt) => rt.id === block.roomTypeId);
  const isLinked = block.protected;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!startDate || !endDate) {
      setError(t("calendar.blockDetail.selectDatesError"));
      return;
    }
    if (endDate <= startDate) {
      setError(t("calendar.blockModal.errorEndAfterStart"));
      return;
    }
    setSubmitting(true);
    try {
      await onSave({ startDate, endDate, reason });
      setEditing(false);
    } catch (err: any) {
      setError(err?.message || t("calendar.blockDetail.updateError"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    setSubmitting(true);
    try {
      await onDelete();
    } catch (err: any) {
      setError(err?.message || t("calendar.blockDetail.unblockError"));
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-900">
          {editing
            ? t("calendar.blockDetail.editTitle")
            : isLinked
              ? t("calendar.blockDetail.linkedTitle")
              : t("calendar.blockDetail.title")}
        </h2>
        <span
          className={`text-[11px] font-medium px-2 py-1 rounded border ${
            isLinked
              ? "bg-amber-100 text-amber-700 border-amber-200"
              : "bg-red-100 text-red-700 border-red-200"
          }`}
        >
          {isLinked ? t("rooms.linked") : t("calendar.blocked")}
        </span>
      </div>

      {!editing ? (
        <div className="space-y-3">
          <div>
            <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
              {t("calendar.blockModal.roomTypeLabel")}
            </div>
            <div className="text-sm text-gray-900 mt-0.5">
              {roomType?.name || t("common.unknown")}
            </div>
          </div>

          {isLinked && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-amber-700">
                {t("bookings.tableSource")}
              </div>
              <div className="mt-0.5 text-sm text-amber-900">
                {block.sourceSummary || block.sourceRoomTypeName || t("rooms.linkedInventory")}
              </div>
              <p className="mt-1 text-xs text-amber-700">
                {t("calendar.blockDetail.linkedDescription")}
              </p>
            </div>
          )}

          <div>
            <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
              {block.roomId ? t("calendar.roomColumn") : t("calendar.blockDetail.roomsBlocked")}
            </div>
            <div className="text-sm text-gray-900 mt-0.5">
              {block.roomId
                ? `#${block.roomNumber ?? ""}`
                : t("calendar.blockDetail.roomCount", { count: block.blockedCount })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                {t("calendar.blockModal.start")}
              </div>
              <div className="text-sm text-gray-900 mt-0.5">{block.startDate}</div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                {t("calendar.blockModal.end")}
              </div>
              <div className="text-sm text-gray-900 mt-0.5">{block.endDate}</div>
            </div>
          </div>

          <div>
            <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
              {t("calendar.blockModal.reasonLabel")}
            </div>
            <div className="text-sm text-gray-900 mt-0.5">
              {block.reason || (
                <span className="text-gray-400">{t("calendar.blockDetail.noReason")}</span>
              )}
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          {isLinked ? (
            <div className="flex justify-end pt-3 border-t border-gray-100">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                {t("common.close")}
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 pt-3 border-t border-gray-100">
              {confirmDelete ? (
                <>
                  <span className="text-sm text-gray-700">
                    {t("calendar.blockDetail.unblockConfirm")}
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmDelete(false)}
                      disabled={submitting}
                      className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      {t("calendar.cancel")}
                    </button>
                    <button
                      onClick={handleDelete}
                      disabled={submitting}
                      className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {submitting
                        ? t("calendar.blockDetail.unblocking")
                        : t("calendar.blockDetail.unblock")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    {t("calendar.blockDetail.unblock")}
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={onClose}
                      className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      {t("common.close")}
                    </button>
                    <button
                      onClick={() => setEditing(true)}
                      className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
                    >
                      {t("common.edit")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("calendar.blockModal.roomTypeLabel")}
            </label>
            <div className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-500 bg-gray-50">
              {roomType?.name || t("common.unknown")}
              {block.roomId && block.roomNumber && (
                <span className="text-gray-400"> &middot; #{block.roomNumber}</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("calendar.blockModal.startDateLabel")}
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("calendar.blockModal.endDateLabel")}
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("calendar.blockModal.reasonLabel")}
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("calendar.blockModal.reasonPlaceholder")}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError("");
              }}
              className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              {t("calendar.cancel")}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50"
            >
              {submitting ? t("common.saving") : t("bookings.modal.saveChanges")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
