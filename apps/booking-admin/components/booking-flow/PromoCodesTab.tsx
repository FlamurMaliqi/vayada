"use client";
import { useTranslation } from "@/lib/i18n";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  AdjustmentsHorizontalIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  PlusIcon,
  TicketIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { Button, FeedbackAlert, Input, ToggleSwitch } from "@/components/ui";
import type { BookingPromoCode } from "@/services/api/bookingPromoCodesClient";

export interface PromoRoomType {
  roomTypeId: string;
  name: string;
}

export interface PromoCodeFormValues {
  code: string;
  discountType: "percentage" | "fixed";
  discountValue: string;
  minBookingValue: string;
  applicableRoomIds: string[];
  validFrom: string;
  validUntil: string;
  stayDateFrom: string;
  stayDateUntil: string;
  maxUses: string;
  isActive: boolean;
}

interface PromoCodesTabProps {
  promoCodes: BookingPromoCode[];
  propertyCurrency: string;
  propertyTimeZone: string;
  roomTypes: PromoRoomType[];
  onCreatePromoCode: (values: PromoCodeFormValues) => Promise<void>;
  onUpdatePromoCode: (promoCodeId: string, values: PromoCodeFormValues) => Promise<void>;
  onDeletePromoCode: (promoCodeId: string) => Promise<void>;
  onTogglePromoCode: (promoCode: BookingPromoCode) => Promise<void>;
}

function emptyDraft(): PromoCodeFormValues {
  return {
    code: "",
    discountType: "percentage",
    discountValue: "",
    minBookingValue: "",
    applicableRoomIds: [],
    validFrom: "",
    validUntil: "",
    stayDateFrom: "",
    stayDateUntil: "",
    maxUses: "1",
    isActive: true,
  };
}

function toDraft(promo: BookingPromoCode): PromoCodeFormValues {
  return {
    code: promo.code,
    discountType: promo.discountType,
    discountValue: promo.discountValue,
    minBookingValue: promo.minBookingValue ?? "",
    applicableRoomIds: promo.applicableRoomIds ?? [],
    validFrom: promo.validFrom ?? "",
    validUntil: promo.validUntil ?? "",
    stayDateFrom: promo.stayDateFrom ?? "",
    stayDateUntil: promo.stayDateUntil ?? "",
    maxUses: String(promo.maxUses),
    isActive: promo.isActive,
  };
}

type PromoStatus = "Active" | "Inactive" | "Expired" | "Exhausted";

function promoStatus(promo: BookingPromoCode, propertyTimeZone: string): PromoStatus {
  if (!promo.isActive) return "Inactive";
  const today = isoDateInTimeZone(propertyTimeZone);
  if (promo.validUntil && promo.validUntil < today) return "Expired";
  if (promo.currentUses >= promo.maxUses) return "Exhausted";
  if (promo.validFrom && promo.validFrom > today) return "Inactive";
  return "Active";
}

function isoDateInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function statusClasses(status: PromoStatus): string {
  if (status === "Active") return "bg-emerald-50 text-emerald-700";
  if (status === "Expired") return "bg-red-50 text-red-700";
  if (status === "Exhausted") return "bg-orange-50 text-orange-700";
  return "bg-gray-100 text-gray-600";
}

export default function PromoCodesTab({
  promoCodes,
  propertyCurrency,
  propertyTimeZone,
  roomTypes,
  onCreatePromoCode,
  onUpdatePromoCode,
  onDeletePromoCode,
  onTogglePromoCode,
}: PromoCodesTabProps) {
  const { t, locale } = useTranslation();
  function dateLabel(value: string | null): string {
    if (!value) return t("admin.noLimit");
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
      new Date(`${value}T12:00:00`),
    );
  }

  function rangeLabel(from: string | null, until: string | null): string {
    if (!from && !until) return t("admin.noLimit");
    if (from && until) return `${dateLabel(from)} – ${dateLabel(until)}`;
    return from
      ? t("admin.fromDate", { date: dateLabel(from) })
      : t("admin.untilDate", { date: dateLabel(until) });
  }

  function validityLabel(from: string | null, until: string | null): string {
    if (!from && !until) return t("admin.noExpiry");
    if (!until) return t("admin.dateNoExpiry", { date: dateLabel(from) });
    return rangeLabel(from, until);
  }

  function stayDatesLabel(from: string | null, until: string | null): string {
    return !from && !until ? t("admin.anyDates") : rangeLabel(from, until);
  }

  function moneyLabel(value: string, currency: string): string {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(Number(value));
  }

  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<PromoCodeFormValues>(emptyDraft);
  const [editingPromo, setEditingPromo] = useState<BookingPromoCode | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [savingPromo, setSavingPromo] = useState(false);
  const [busyPromoId, setBusyPromoId] = useState<string | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  const filteredPromoCodes = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return promoCodes;
    return promoCodes.filter((promo) =>
      [promo.code, t(`promos.status.${promoStatus(promo, propertyTimeZone)}`)].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [promoCodes, propertyTimeZone, search, t]);

  const openEditor = (promo: BookingPromoCode | null) => {
    lastFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingPromo(promo);
    setDraft(promo ? toDraft(promo) : emptyDraft());
    setPromoError(null);
    setIsEditorOpen(true);
  };

  const closeEditor = useCallback(() => {
    if (savingPromo) return;
    setIsEditorOpen(false);
    setEditingPromo(null);
    setPromoError(null);
    lastFocusRef.current?.focus();
  }, [savingPromo]);

  useEffect(() => {
    if (!isEditorOpen) return;
    dialogRef.current?.querySelector<HTMLElement>("#promo-code")?.focus();
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [isEditorOpen]);

  useEffect(() => {
    if (!isEditorOpen) return;
    const dialog = dialogRef.current;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, input, select, summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeEditor, isEditorOpen]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = draft.code.trim().toUpperCase();
    const discountValue = Number(draft.discountValue);
    const minBookingValue = draft.minBookingValue.trim();
    const maxUses = Number(draft.maxUses);

    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) {
      setPromoError(t("admin.use240LettersNumbersHyphensOrUnderscoresForThe"));
      return;
    }
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      setPromoError(t("admin.discountValueMustBeGreaterThanZero"));
      return;
    }
    if (draft.discountType === "percentage" && discountValue > 100) {
      setPromoError(t("admin.percentageDiscountsCannotExceed100"));
      return;
    }
    if (
      minBookingValue &&
      (!Number.isFinite(Number(minBookingValue)) || Number(minBookingValue) <= 0)
    ) {
      setPromoError(t("admin.minimumBookingValueMustBeGreaterThanZero"));
      return;
    }
    if (!Number.isInteger(maxUses) || maxUses <= 0) {
      setPromoError(t("admin.usageLimitMustBeAWholeNumberGreaterThanZero"));
      return;
    }
    if (draft.validFrom && draft.validUntil && draft.validUntil < draft.validFrom) {
      setPromoError(t("admin.validUntilMustBeOnOrAfterValidFrom"));
      return;
    }
    if (draft.stayDateFrom && draft.stayDateUntil && draft.stayDateUntil < draft.stayDateFrom) {
      setPromoError(t("admin.stayUntilMustBeOnOrAfterStayFrom"));
      return;
    }

    const normalized = {
      ...draft,
      code,
      discountValue: discountValue.toFixed(2),
      minBookingValue: minBookingValue ? Number(minBookingValue).toFixed(2) : "",
      maxUses: String(maxUses),
    };
    setSavingPromo(true);
    setPromoError(null);
    try {
      if (editingPromo) await onUpdatePromoCode(editingPromo.promoCodeId, normalized);
      else await onCreatePromoCode(normalized);
      setIsEditorOpen(false);
      setEditingPromo(null);
      lastFocusRef.current?.focus();
    } catch {
      setPromoError(t("admin.failedToSavePromoCode"));
    } finally {
      setSavingPromo(false);
    }
  };

  const handleDelete = async (promo: BookingPromoCode) => {
    if (!window.confirm(t("admin.deleteName", { name: promo.code }))) return;
    setBusyPromoId(promo.promoCodeId);
    setPromoError(null);
    try {
      await onDeletePromoCode(promo.promoCodeId);
    } catch {
      setPromoError(t("admin.failedToDeletePromoCode"));
    } finally {
      setBusyPromoId(null);
    }
  };

  const roomNames = (roomIds: string[] | null) => {
    if (!roomIds?.length) return t("admin.allRooms");
    const names = roomIds.map(
      (roomId) =>
        roomTypes.find((room) => room.roomTypeId === roomId)?.name ?? t("admin.unknownRoom"),
    );
    return names.length > 2
      ? `${names.slice(0, 2).join(", ")} +${names.length - 2}`
      : names.join(", ");
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950">
            {t("bookingFlow.tabs.promos")}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {t("admin.targetedDiscountsGuestsUnlockByEnteringACodeAtCheckout")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => openEditor(null)}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700"
        >
          <PlusIcon className="h-4 w-4" />
          {t("admin.newPromoCode")}
        </button>
      </div>

      {promoError && !isEditorOpen && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {promoError}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 p-4">
          <label className="relative block max-w-sm">
            <span className="sr-only">{t("admin.searchPromoCodes")}</span>
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-2.5 h-5 w-5 text-gray-400" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("admin.searchCodes")}
              className="h-10 w-full rounded-lg border border-gray-300 pl-10 pr-3 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
            />
          </label>
        </div>

        {promoCodes.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
              <TicketIcon className="h-6 w-6 text-gray-500" />
            </span>
            <h2 className="mt-4 text-sm font-semibold text-gray-900">
              {t("bookingFlow.promoCodes.noPromoCodes")}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {t("admin.createYourFirstCodeToRewardGuests")}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-left">
              <thead className="bg-gray-50 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-5 py-3">{t("affiliates.allAffiliates.code")}</th>
                  <th className="px-4 py-3">{t("admin.discount")}</th>
                  <th className="px-4 py-3">{t("admin.validity")}</th>
                  <th className="px-4 py-3">{t("admin.stayDates")}</th>
                  <th className="px-4 py-3">{t("admin.rooms")}</th>
                  <th className="px-4 py-3">{t("admin.usage")}</th>
                  <th className="px-5 py-3 text-right">{t("manageHotels.table.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-sm">
                {filteredPromoCodes.map((promo) => {
                  const status = promoStatus(promo, propertyTimeZone);
                  const usage = Math.min(100, (promo.currentUses / promo.maxUses) * 100);
                  return (
                    <tr key={promo.promoCodeId} className="hover:bg-gray-50/70">
                      <td className="px-5 py-4">
                        <div className="font-mono font-semibold text-gray-950">{promo.code}</div>
                        <span
                          className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClasses(status)}`}
                        >
                          {t(`promos.status.${status}`)}
                        </span>
                      </td>
                      <td className="px-4 py-4 font-medium text-gray-900">
                        {promo.discountType === "percentage"
                          ? `${Number(promo.discountValue)}%`
                          : t("admin.amountOff", {
                              amount: moneyLabel(promo.discountValue, propertyCurrency),
                            })}
                      </td>
                      <td className="px-4 py-4 text-gray-600">
                        {validityLabel(promo.validFrom, promo.validUntil)}
                        {promo.minBookingValue && (
                          <div className="mt-1 text-xs font-normal text-gray-500">
                            {t("admin.min")}
                            {moneyLabel(promo.minBookingValue, propertyCurrency)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-4 text-gray-600">
                        {stayDatesLabel(promo.stayDateFrom, promo.stayDateUntil)}
                      </td>
                      <td
                        className="max-w-[180px] truncate px-4 py-4 text-gray-600"
                        title={roomNames(promo.applicableRoomIds)}
                      >
                        {roomNames(promo.applicableRoomIds)}
                      </td>
                      <td className="px-4 py-4">
                        <div className="text-xs text-gray-600">
                          {promo.currentUses}/{promo.maxUses} {t("admin.used")}
                        </div>
                        <div className="mt-2 h-1.5 w-24 overflow-hidden rounded-full bg-gray-100">
                          <div
                            className="h-full rounded-full bg-primary-600"
                            style={{ width: `${usage}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={promo.isActive}
                            aria-label={`${promo.isActive ? t("featureHub.copy.deactivate") : t("admin.activate")} ${promo.code}`}
                            disabled={busyPromoId === promo.promoCodeId}
                            onClick={async () => {
                              setBusyPromoId(promo.promoCodeId);
                              try {
                                await onTogglePromoCode(promo);
                              } catch {
                                setPromoError(t("admin.failedToUpdatePromoCode"));
                              } finally {
                                setBusyPromoId(null);
                              }
                            }}
                            className={`relative order-3 ml-2 h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${promo.isActive ? "bg-primary-600" : "bg-gray-300"}`}
                          >
                            <span
                              className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${promo.isActive ? "translate-x-4" : "translate-x-0"}`}
                            />
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditor(promo)}
                            aria-label={t("admin.editName", { name: promo.code })}
                            className="order-1 rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                          >
                            <PencilSquareIcon className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(promo)}
                            disabled={busyPromoId === promo.promoCodeId}
                            aria-label={t("admin.deleteName2", { name: promo.code })}
                            className="order-2 rounded-md p-2 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filteredPromoCodes.length === 0 && (
              <p className="px-6 py-12 text-center text-sm text-gray-500">
                {t("admin.noPromoCodesMatchYourSearch")}
              </p>
            )}
          </div>
        )}
      </div>

      {isEditorOpen && (
        <ModalOverlay
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/45 p-0 sm:p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeEditor();
          }}
        >
          <form
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="promo-editor-title"
            aria-describedby={`promo-editor-description${promoError ? " promo-editor-error" : ""}`}
            onSubmit={handleSubmit}
            className="flex h-[100dvh] w-full max-w-[920px] flex-col overflow-hidden bg-white shadow-2xl sm:h-auto sm:max-h-[92dvh] sm:rounded-2xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-gray-200 px-5 py-5 sm:px-7">
              <div className="flex min-w-0 items-start gap-3.5">
                <span className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 sm:flex">
                  <TicketIcon className="h-5 w-5" />
                </span>
                <div>
                  <h2 id="promo-editor-title" className="text-xl font-semibold text-gray-950">
                    {editingPromo ? t("admin.editPromoCode") : t("admin.createPromoCode")}
                  </h2>
                  <p id="promo-editor-description" className="mt-1 max-w-2xl text-sm text-gray-600">
                    {t("admin.guestsEnterThisCodeInTheBookingEngineDiscountsUse2", {
                      currency: propertyCurrency,
                    })}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeEditor}
                disabled={savingPromo}
                aria-label={t("admin.closePromoCodeEditor")}
                className="-mr-2 shrink-0 rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50/70 px-4 py-5 sm:px-7 sm:py-6">
              <div className="grid gap-5 md:grid-cols-2 md:items-start">
                <section
                  aria-labelledby="promo-details-heading"
                  className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
                >
                  <div className="mb-5 flex items-center gap-2.5 border-b border-gray-100 pb-4">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50 text-primary-700">
                      <TicketIcon className="h-4 w-4" />
                    </span>
                    <h3 id="promo-details-heading" className="text-sm font-semibold text-gray-950">
                      {t("admin.promoDetails")}
                    </h3>
                  </div>
                  <div className="space-y-5">
                    <Field
                      id="promo-code"
                      label={t("affiliates.allAffiliates.code")}
                      helper={t("promos.codeHint")}
                    >
                      <Input
                        id="promo-code"
                        aria-describedby="promo-code-helper"
                        autoComplete="off"
                        required
                        maxLength={40}
                        value={draft.code}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            code: event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""),
                          }))
                        }
                        placeholder={t("admin.eGSUMMER20")}
                        className={inputClass}
                      />
                    </Field>

                    <fieldset>
                      <legend className="text-sm font-medium text-gray-800">
                        {t("admin.discountType")}
                      </legend>
                      <p
                        id="promo-discount-type-helper"
                        className="mb-2 mt-1 text-xs text-gray-600"
                      >
                        {t("admin.chooseHowTheDiscountIsCalculated")}
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        {(["percentage", "fixed"] as const).map((type) => (
                          <label
                            key={type}
                            className={`cursor-pointer rounded-lg border p-3 transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2 ${draft.discountType === type ? "border-primary-600 bg-primary-50/60" : "border-gray-200 hover:border-gray-300"}`}
                          >
                            <input
                              className="sr-only"
                              type="radio"
                              name="discountType"
                              value={type}
                              aria-describedby="promo-discount-type-helper"
                              checked={draft.discountType === type}
                              onChange={() =>
                                setDraft((current) => ({ ...current, discountType: type }))
                              }
                            />
                            <span className="block text-sm font-medium capitalize text-gray-900">
                              {type === "fixed" ? t("admin.fixedAmount") : t("admin.percentage")}
                            </span>
                            <span className="mt-0.5 block text-xs text-gray-600">
                              {type === "fixed"
                                ? t("admin.currencyOffTheTotal", { currency: propertyCurrency })
                                : t("bookingFlow.promoCodes.percentageOff")}
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <Field
                      id="promo-discount-value"
                      label={t("admin.discountValue")}
                      helper={
                        draft.discountType === "fixed"
                          ? t("admin.usesYourPropertyCurrencyCurrency", {
                              currency: propertyCurrency,
                            })
                          : t("admin.percentageRange")
                      }
                    >
                      <div className="relative">
                        <Input
                          id="promo-discount-value"
                          aria-describedby="promo-discount-value-helper"
                          required
                          type="number"
                          min="0.01"
                          max={draft.discountType === "percentage" ? "100" : undefined}
                          step="0.01"
                          value={draft.discountValue}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              discountValue: event.target.value,
                            }))
                          }
                          className={`${inputClass} pr-14`}
                        />
                        <span className="pointer-events-none absolute right-3 top-3 text-sm text-gray-600">
                          {draft.discountType === "percentage" ? "%" : propertyCurrency}
                        </span>
                      </div>
                    </Field>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field
                        id="promo-valid-from"
                        label={t("admin.validFrom")}
                        helper={t("promos.immediateHint")}
                      >
                        <Input
                          id="promo-valid-from"
                          aria-describedby="promo-valid-from-helper"
                          type="date"
                          value={draft.validFrom}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, validFrom: event.target.value }))
                          }
                          className={inputClass}
                        />
                      </Field>
                      <Field
                        id="promo-valid-until"
                        label={t("admin.validUntil")}
                        helper={t("promos.expiryHint")}
                      >
                        <Input
                          id="promo-valid-until"
                          aria-describedby="promo-valid-until-helper"
                          type="date"
                          value={draft.validUntil}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, validUntil: event.target.value }))
                          }
                          className={inputClass}
                        />
                      </Field>
                    </div>

                    <ToggleSwitch
                      size="sm"
                      enabled={draft.isActive}
                      onChange={() =>
                        setDraft((current) => ({ ...current, isActive: !current.isActive }))
                      }
                      label={t("promos.status.Active")}
                      description={t("admin.turnOffToPauseTheCodeWithoutDeletingIt")}
                    />
                  </div>
                </section>

                <section
                  aria-labelledby="promo-rules-heading"
                  className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
                >
                  <div className="mb-5 flex items-center gap-2.5 border-b border-gray-100 pb-4">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50 text-primary-700">
                      <AdjustmentsHorizontalIcon className="h-4 w-4" />
                    </span>
                    <h3 id="promo-rules-heading" className="text-sm font-semibold text-gray-950">
                      {t("admin.rulesRestrictions")}
                    </h3>
                  </div>
                  <div className="space-y-5">
                    <Field
                      id="promo-min-booking-value"
                      label={t("admin.minimumBookingValue")}
                      helper={t("promos.minimumHint")}
                    >
                      <div className="relative">
                        <Input
                          id="promo-min-booking-value"
                          aria-describedby="promo-min-booking-value-helper"
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={draft.minBookingValue}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              minBookingValue: event.target.value,
                            }))
                          }
                          placeholder={t("admin.eG500")}
                          className={`${inputClass} pr-14`}
                        />
                        <span className="pointer-events-none absolute right-3 top-3 text-sm text-gray-600">
                          {propertyCurrency}
                        </span>
                      </div>
                    </Field>

                    <Field
                      id="promo-max-uses"
                      label={t("admin.maxUses")}
                      helper={t("promos.usageHint")}
                    >
                      <Input
                        id="promo-max-uses"
                        aria-describedby="promo-max-uses-helper"
                        required
                        type="number"
                        min="1"
                        step="1"
                        value={draft.maxUses}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, maxUses: event.target.value }))
                        }
                        className={inputClass}
                      />
                    </Field>

                    <div>
                      <p id="promo-rooms-label" className="text-sm font-medium text-gray-800">
                        {t("admin.applicableRooms")}
                      </p>
                      <p id="promo-rooms-helper" className="mb-2 mt-1 text-xs text-gray-600">
                        {t("admin.leaveAsAllRoomsToApplyToAnyBookingOr")}
                      </p>
                      <details className="group rounded-lg border border-gray-300 bg-white">
                        <summary
                          aria-labelledby="promo-rooms-label promo-rooms-value"
                          aria-describedby="promo-rooms-helper"
                          className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
                        >
                          <span id="promo-rooms-value">
                            {draft.applicableRoomIds.length === 0
                              ? t("admin.allRooms")
                              : t("admin.selectedRoomsCount", {
                                  count: draft.applicableRoomIds.length,
                                })}
                          </span>
                          <ChevronDownIcon className="h-4 w-4 shrink-0 text-gray-500 transition-transform group-open:rotate-180" />
                        </summary>
                        <div className="max-h-40 space-y-1 overflow-y-auto border-t border-gray-200 p-2">
                          {roomTypes.length === 0 ? (
                            <p className="px-2 py-1 text-xs text-gray-500">
                              {t("admin.noRoomTypesAvailable")}
                            </p>
                          ) : (
                            roomTypes.map((room) => (
                              <label
                                key={room.roomTypeId}
                                className="flex items-center gap-2 rounded px-2 py-2 text-sm text-gray-700 hover:bg-gray-50"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.applicableRoomIds.includes(room.roomTypeId)}
                                  onChange={(event) =>
                                    setDraft((current) => ({
                                      ...current,
                                      applicableRoomIds: event.target.checked
                                        ? [...current.applicableRoomIds, room.roomTypeId]
                                        : current.applicableRoomIds.filter(
                                            (id) => id !== room.roomTypeId,
                                          ),
                                    }))
                                  }
                                  className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                />
                                {room.name}
                              </label>
                            ))
                          )}
                        </div>
                      </details>
                    </div>

                    <DateRangeFields
                      legend={t("promos.stayDates")}
                      helper={t("promos.stayDatesHint")}
                      from={draft.stayDateFrom}
                      until={draft.stayDateUntil}
                      onFrom={(value) =>
                        setDraft((current) => ({ ...current, stayDateFrom: value }))
                      }
                      onUntil={(value) =>
                        setDraft((current) => ({ ...current, stayDateUntil: value }))
                      }
                    />
                  </div>
                </section>
              </div>
            </div>

            {promoError && (
              <div id="promo-editor-error" role="alert" className="shrink-0 px-5 pt-4 sm:px-7">
                <FeedbackAlert type="error" message={promoError} />
              </div>
            )}
            <div className="flex shrink-0 flex-col-reverse gap-3 border-t border-gray-200 bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-7">
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={closeEditor}
                disabled={savingPromo}
                className="h-11 w-full sm:w-auto"
              >
                {t("settings.totp.cancel")}
              </Button>
              <Button
                type="submit"
                size="lg"
                disabled={savingPromo}
                className="h-11 w-full sm:w-auto"
              >
                {savingPromo
                  ? t("addons.editor.saving")
                  : editingPromo
                    ? t("admin.saveChanges")
                    : t("admin.createPromoCode")}
              </Button>
            </div>
          </form>
        </ModalOverlay>
      )}
    </div>
  );
}

const inputClass = "h-11 !text-sm placeholder:text-gray-500";

function ModalOverlay(props: React.ComponentProps<"div">) {
  return createPortal(<div {...props} />, document.body);
}

function Field({
  id,
  label,
  helper,
  children,
}: {
  id: string;
  label: string;
  helper: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-gray-800">
        {label}
      </label>
      <p id={`${id}-helper`} className="mb-2 mt-1 text-xs text-gray-600">
        {helper}
      </p>
      {children}
    </div>
  );
}

function DateRangeFields({
  legend,
  helper,
  from,
  until,
  onFrom,
  onUntil,
}: {
  legend: string;
  helper: string;
  from: string;
  until: string;
  onFrom: (value: string) => void;
  onUntil: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset>
      <legend className="text-sm font-medium text-gray-800">{legend}</legend>
      <p id="promo-stay-dates-helper" className="mb-2 mt-1 text-xs text-gray-600">
        {helper}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="promo-stay-from" className="text-xs font-medium text-gray-600">
            {t("admin.staysFrom")}
          </label>
          <Input
            id="promo-stay-from"
            aria-describedby="promo-stay-dates-helper"
            type="date"
            value={from}
            onChange={(event) => onFrom(event.target.value)}
            className={`${inputClass} mt-1`}
          />
        </div>
        <div>
          <label htmlFor="promo-stay-until" className="text-xs font-medium text-gray-600">
            {t("admin.staysUntil")}
          </label>
          <Input
            id="promo-stay-until"
            aria-describedby="promo-stay-dates-helper"
            type="date"
            value={until}
            onChange={(event) => onUntil(event.target.value)}
            className={`${inputClass} mt-1`}
          />
        </div>
      </div>
    </fieldset>
  );
}
