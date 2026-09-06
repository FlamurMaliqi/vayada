"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TrashIcon, XMarkIcon, PlusIcon } from "@heroicons/react/24/outline";
import { HotelIcon } from "@vayada/product-onboarding";
import { settingsService, type HotelSummary } from "@/services/settings";
import { FeedbackAlert } from "@/components/ui";
import { useTranslation } from "@/lib/i18n";

type Toast = { type: "success" | "error"; message: string } | null;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Currently selected hotel id — gets the "Active" badge. */
  selectedHotelId?: string | null;
  /** Fired after a successful delete so the parent (Header) can sync its state. */
  onDeleted?: (deletedId: string, remaining: HotelSummary[]) => void;
}

export default function ManagePropertiesModal({ open, onClose, selectedHotelId }: Props) {
  const router = useRouter();
  const { t } = useTranslation();
  const [hotels, setHotels] = useState<HotelSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<Toast>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setToast(null);
    settingsService
      .listHotels()
      .then(setHotels)
      .catch(() => setToast({ type: "error", message: t("manageProperties.toast.error") }))
      .finally(() => setLoading(false));
  }, [open, t]);

  if (!open) return null;

  const handleClose = () => {
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={handleClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-3">
          <div>
            <h2 className="text-[17px] font-semibold text-gray-900">
              {t("manageProperties.title")}
            </h2>
            <p className="text-[12px] text-gray-500 mt-0.5">
              {hotels.length === 0
                ? t("manageProperties.empty")
                : t("manageProperties.countSubtitle", { count: hotels.length })}
            </p>
          </div>
          <button
            onClick={handleClose}
            className="p-1 -mr-1 text-gray-400 hover:text-gray-600 rounded-md"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {toast && (
          <div className="px-5 pb-2">
            <FeedbackAlert type={toast.type} message={toast.message} />
          </div>
        )}

        {/* List */}
        <div className="px-5 pb-3 overflow-y-auto flex-1 space-y-2">
          {loading ? (
            <div className="p-6 text-center text-[13px] text-gray-400">…</div>
          ) : hotels.length === 0 ? (
            <div className="p-6 text-center text-[13px] text-gray-500">
              {t("manageProperties.empty")}
            </div>
          ) : (
            hotels.map((hotel) => {
              const isActive = hotel.id === selectedHotelId;
              return (
                <div
                  key={hotel.id}
                  className={`flex items-center gap-3 p-3 rounded-xl border-2 transition-colors ${
                    isActive ? "border-primary-500 bg-primary-50/30" : "border-gray-200"
                  }`}
                >
                  <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                    <HotelIcon className="w-5 h-5 text-gray-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-[14px] font-semibold text-gray-900 truncate">
                        {hotel.name}
                      </p>
                      {isActive && (
                        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold bg-primary-100 text-primary-700 rounded">
                          {t("manageProperties.activeBadge")}
                        </span>
                      )}
                    </div>
                    {hotel.location && (
                      <p className="text-[12px] text-gray-500 truncate">{hotel.location}</p>
                    )}
                  </div>
                  <div
                    className="flex shrink-0 items-center gap-2"
                    title={t("admin.propertyDeletionIsNotAvailableYet")}
                  >
                    <span className="hidden text-[10px] font-medium text-gray-400 sm:inline">
                      {t("admin.deletionUnavailable")}
                    </span>
                    <button
                      type="button"
                      disabled
                      aria-label={t("admin.deleteNotAvailableYet")}
                      className="cursor-not-allowed rounded-lg p-2 text-gray-300"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 px-5 py-3 flex justify-end">
          <button
            onClick={() => {
              onClose();
              router.push("/setup?mode=add");
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium text-primary-600 border border-dashed border-primary-300 rounded-lg hover:bg-primary-50 transition-colors"
          >
            <PlusIcon className="w-4 h-4" />
            {t("layout.header.addProperty")}
          </button>
        </div>
      </div>
    </div>
  );
}
