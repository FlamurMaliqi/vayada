"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TrashIcon, XMarkIcon, PlusIcon } from "@heroicons/react/24/outline";
import { HotelIcon } from "@vayada/product-onboarding";
import { settingsService, type HotelSummary, type HotelDeletionImpact } from "@/services/settings";
import { Button, FeedbackAlert } from "@/components/ui";
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

export default function ManagePropertiesModal({
  open,
  onClose,
  selectedHotelId,
  onDeleted,
}: Props) {
  const router = useRouter();
  const { t } = useTranslation();
  const [hotels, setHotels] = useState<HotelSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<HotelSummary | null>(null);
  const [impact, setImpact] = useState<HotelDeletionImpact | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
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

  const openConfirm = async (hotel: HotelSummary) => {
    setTarget(hotel);
    setImpact(null);
    setStep(1);
    setTyped("");
    try {
      const data = await settingsService.getHotelDeletionImpact(hotel.id);
      setImpact(data);
    } catch {
      setImpact({ upcomingBookingsCount: 0, connectedChannelsCount: 0 });
    }
  };

  const closeConfirmDialog = () => {
    if (submitting) return;
    setTarget(null);
    setImpact(null);
    setStep(1);
    setTyped("");
  };

  const handleClose = () => {
    if (submitting) return;
    closeConfirmDialog();
    onClose();
  };

  const onConfirmDelete = async () => {
    if (!target || typed !== target.name) return;
    setSubmitting(true);
    try {
      await settingsService.deleteHotel(target.id);
      const remaining = hotels.filter((h) => h.id !== target.id);
      setHotels(remaining);
      onDeleted?.(target.id, remaining);

      setToast({
        type: "success",
        message: t("manageProperties.toast.deleted", { name: target.name }),
      });
      closeConfirmDialog();

      if (remaining.length === 0) {
        onClose();
        router.push("/setup?mode=add");
      }
    } catch {
      setToast({ type: "error", message: t("manageProperties.toast.error") });
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
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
            disabled={submitting}
            className="p-1 -mr-1 text-gray-400 hover:text-gray-600 rounded-md disabled:opacity-50"
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
                  <button
                    onClick={() => openConfirm(hotel)}
                    aria-label={t("manageProperties.delete")}
                    className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors shrink-0"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
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

      {target && step === 1 && (
        <DeleteWarningDialog
          name={target.name}
          impact={impact}
          loading={submitting}
          onCancel={closeConfirmDialog}
          onConfirm={() => setStep(2)}
          t={t}
        />
      )}

      {target && step === 2 && (
        <DeleteNameMatchDialog
          name={target.name}
          typed={typed}
          onTyped={setTyped}
          loading={submitting}
          onCancel={closeConfirmDialog}
          onConfirm={onConfirmDelete}
          t={t}
        />
      )}
    </div>
  );
}

function DeleteWarningDialog({
  name,
  impact,
  loading,
  onCancel,
  onConfirm,
  t,
}: {
  name: string;
  impact: HotelDeletionImpact | null;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  return (
    <DialogShell title={t("manageProperties.confirm.title")} onClose={onCancel} loading={loading}>
      <p className="text-[13px] text-gray-700">{t("manageProperties.confirm.body", { name })}</p>
      {impact && impact.upcomingBookingsCount > 0 && (
        <div className="mt-3 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[12px] text-amber-900">
          {t("manageProperties.confirm.bookingsWarning", { count: impact.upcomingBookingsCount })}
        </div>
      )}
      {impact && impact.connectedChannelsCount > 0 && (
        <div className="mt-3 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[12px] text-amber-900">
          {t("manageProperties.confirm.channelsWarning", { count: impact.connectedChannelsCount })}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 mt-5">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={loading}>
          {t("manageProperties.confirm.cancel")}
        </Button>
        <Button variant="danger" size="sm" onClick={onConfirm} disabled={loading}>
          {t("manageProperties.confirm.proceed")}
        </Button>
      </div>
    </DialogShell>
  );
}

function DeleteNameMatchDialog({
  name,
  typed,
  onTyped,
  loading,
  onCancel,
  onConfirm,
  t,
}: {
  name: string;
  typed: string;
  onTyped: (v: string) => void;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  const matches = typed === name;
  return (
    <DialogShell
      title={t("manageProperties.confirmName.title")}
      onClose={onCancel}
      loading={loading}
    >
      <p className="text-[13px] text-gray-700">
        {t("manageProperties.confirmName.body", { name })}
      </p>
      <input
        type="text"
        value={typed}
        onChange={(e) => onTyped(e.target.value)}
        placeholder={t("manageProperties.confirmName.placeholder")}
        autoFocus
        disabled={loading}
        className="mt-3 w-full px-3 py-2 text-[13px] border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500"
      />
      <div className="flex items-center justify-end gap-2 mt-5">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={loading}>
          {t("manageProperties.confirm.cancel")}
        </Button>
        <Button variant="danger" size="sm" onClick={onConfirm} disabled={!matches || loading}>
          {t("manageProperties.confirmName.button")}
        </Button>
      </div>
    </DialogShell>
  );
}

function DialogShell({
  title,
  onClose,
  loading,
  children,
}: {
  title: string;
  onClose: () => void;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={loading ? undefined : onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>
          <button
            onClick={onClose}
            disabled={loading}
            className="p-1 text-gray-400 hover:text-gray-600 rounded-md disabled:opacity-50"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
