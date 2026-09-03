"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  MagnifyingGlassIcon,
  PencilSquareIcon,
  PlusIcon,
  TicketIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
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

function dateLabel(value: string | null): string {
  if (!value) return "No limit";
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}.${month}.${year}` : value;
}

function rangeLabel(from: string | null, until: string | null): string {
  if (!from && !until) return "No limit";
  if (from && until) return `${dateLabel(from)} – ${dateLabel(until)}`;
  return from ? `From ${dateLabel(from)}` : `Until ${dateLabel(until)}`;
}

function validityLabel(from: string | null, until: string | null): string {
  if (!from && !until) return "No expiry.";
  if (!until) return `${dateLabel(from)} – No expiry.`;
  return rangeLabel(from, until);
}

function stayDatesLabel(from: string | null, until: string | null): string {
  return !from && !until ? "Any dates" : rangeLabel(from, until);
}

function moneyLabel(value: string, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(value));
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
      [promo.code, promoStatus(promo, propertyTimeZone)].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [promoCodes, propertyTimeZone, search]);

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
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("input, button")?.focus();

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
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeEditor, isEditorOpen]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = draft.code.trim().toUpperCase();
    const discountValue = Number(draft.discountValue);
    const minBookingValue = draft.minBookingValue.trim();
    const maxUses = Number(draft.maxUses);

    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) {
      setPromoError("Use 2–40 letters, numbers, hyphens, or underscores for the code.");
      return;
    }
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      setPromoError("Discount value must be greater than zero.");
      return;
    }
    if (draft.discountType === "percentage" && discountValue > 100) {
      setPromoError("Percentage discounts cannot exceed 100%.");
      return;
    }
    if (
      minBookingValue &&
      (!Number.isFinite(Number(minBookingValue)) || Number(minBookingValue) <= 0)
    ) {
      setPromoError("Minimum booking value must be greater than zero.");
      return;
    }
    if (!Number.isInteger(maxUses) || maxUses <= 0) {
      setPromoError("Usage limit must be a whole number greater than zero.");
      return;
    }
    if (draft.validFrom && draft.validUntil && draft.validUntil < draft.validFrom) {
      setPromoError("Valid until must be on or after valid from.");
      return;
    }
    if (draft.stayDateFrom && draft.stayDateUntil && draft.stayDateUntil < draft.stayDateFrom) {
      setPromoError("Stay until must be on or after stay from.");
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
    } catch (error) {
      setPromoError(error instanceof Error ? error.message : "Failed to save promo code.");
    } finally {
      setSavingPromo(false);
    }
  };

  const handleDelete = async (promo: BookingPromoCode) => {
    if (!window.confirm(`Delete ${promo.code}?`)) return;
    setBusyPromoId(promo.promoCodeId);
    setPromoError(null);
    try {
      await onDeletePromoCode(promo.promoCodeId);
    } catch (error) {
      setPromoError(error instanceof Error ? error.message : "Failed to delete promo code.");
    } finally {
      setBusyPromoId(null);
    }
  };

  const roomNames = (roomIds: string[] | null) => {
    if (!roomIds?.length) return "All rooms";
    const names = roomIds.map(
      (roomId) => roomTypes.find((room) => room.roomTypeId === roomId)?.name ?? "Unknown room",
    );
    return names.length > 2
      ? `${names.slice(0, 2).join(", ")} +${names.length - 2}`
      : names.join(", ");
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950">Promo Codes</h1>
          <p className="mt-1 text-sm text-gray-500">
            Targeted discounts for your direct booking engine. Prices and discounts use the property
            currency ({propertyCurrency}).
          </p>
        </div>
        <button
          type="button"
          onClick={() => openEditor(null)}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700"
        >
          <PlusIcon className="h-4 w-4" />
          New promo code
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
            <span className="sr-only">Search promo codes</span>
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-2.5 h-5 w-5 text-gray-400" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search codes..."
              className="h-10 w-full rounded-lg border border-gray-300 pl-10 pr-3 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
            />
          </label>
        </div>

        {promoCodes.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
              <TicketIcon className="h-6 w-6 text-gray-500" />
            </span>
            <h2 className="mt-4 text-sm font-semibold text-gray-900">No promo codes yet</h2>
            <p className="mt-1 text-sm text-gray-500">Create your first code to reward guests.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-left">
              <thead className="bg-gray-50 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-5 py-3">Code</th>
                  <th className="px-4 py-3">Discount</th>
                  <th className="px-4 py-3">Validity</th>
                  <th className="px-4 py-3">Stay dates</th>
                  <th className="px-4 py-3">Rooms</th>
                  <th className="px-4 py-3">Usage</th>
                  <th className="px-5 py-3 text-right">Actions</th>
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
                          {status}
                        </span>
                      </td>
                      <td className="px-4 py-4 font-medium text-gray-900">
                        {promo.discountType === "percentage"
                          ? `${Number(promo.discountValue)}%`
                          : `${moneyLabel(promo.discountValue, propertyCurrency)} off`}
                      </td>
                      <td className="px-4 py-4 text-gray-600">
                        {validityLabel(promo.validFrom, promo.validUntil)}
                        {promo.minBookingValue && (
                          <div className="mt-1 text-xs font-normal text-gray-500">
                            Min. {moneyLabel(promo.minBookingValue, propertyCurrency)}
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
                          {promo.currentUses}/{promo.maxUses} used
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
                            aria-label={`${promo.isActive ? "Deactivate" : "Activate"} ${promo.code}`}
                            disabled={busyPromoId === promo.promoCodeId}
                            onClick={async () => {
                              setBusyPromoId(promo.promoCodeId);
                              try {
                                await onTogglePromoCode(promo);
                              } catch (error) {
                                setPromoError(
                                  error instanceof Error
                                    ? error.message
                                    : "Failed to update promo code.",
                                );
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
                            aria-label={`Edit ${promo.code}`}
                            className="order-1 rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                          >
                            <PencilSquareIcon className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(promo)}
                            disabled={busyPromoId === promo.promoCodeId}
                            aria-label={`Delete ${promo.code}`}
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
                No promo codes match your search.
              </p>
            )}
          </div>
        )}
      </div>

      {isEditorOpen && (
        <ModalOverlay
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/45 p-4"
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
            onSubmit={handleSubmit}
            className="max-h-[92vh] w-full max-w-[844px] overflow-y-auto rounded-2xl bg-white shadow-2xl"
          >
            <div className="flex items-start justify-between border-b border-gray-200 px-6 py-5">
              <div>
                <h2 id="promo-editor-title" className="text-xl font-semibold text-gray-950">
                  {editingPromo ? "Edit promo code" : "Create promo code"}
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  Guests enter this code in the booking engine. Discounts use the property currency
                  ({propertyCurrency}).
                </p>
              </div>
              <button
                type="button"
                onClick={closeEditor}
                aria-label="Close promo code editor"
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="grid gap-8 px-6 py-6 md:grid-cols-2">
              <div className="space-y-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Promo details
                </h3>
                <Field label="Code" helper="Letters, numbers, - and _ only. Must be unique.">
                  <input
                    required
                    maxLength={40}
                    value={draft.code}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        code: event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""),
                      }))
                    }
                    placeholder="E.G. SUMMER20"
                    className={inputClass}
                  />
                </Field>

                <fieldset>
                  <legend className="text-sm font-medium text-gray-800">Discount type</legend>
                  <div className="grid grid-cols-2 gap-3">
                    {(["percentage", "fixed"] as const).map((type) => (
                      <label
                        key={type}
                        className={`cursor-pointer rounded-lg border p-3 ${draft.discountType === type ? "border-primary-600 bg-primary-50/50 ring-1 ring-primary-600" : "border-gray-200"}`}
                      >
                        <input
                          className="sr-only"
                          type="radio"
                          name="discountType"
                          value={type}
                          checked={draft.discountType === type}
                          onChange={() =>
                            setDraft((current) => ({ ...current, discountType: type }))
                          }
                        />
                        <span className="block text-sm font-medium capitalize text-gray-900">
                          {type === "fixed" ? "Fixed amount" : "Percentage"}
                        </span>
                        <span className="mt-0.5 block text-xs text-gray-500">
                          {type === "fixed"
                            ? `${propertyCurrency} off the total`
                            : "% off the booking total"}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <Field
                  label="Discount value"
                  helper={
                    draft.discountType === "fixed"
                      ? `Uses your property currency (${propertyCurrency}).`
                      : "Enter a percentage from 0.01 to 100."
                  }
                >
                  <div className="relative">
                    <input
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
                    <span className="absolute right-3 top-2.5 text-sm text-gray-500">
                      {draft.discountType === "percentage" ? "%" : propertyCurrency}
                    </span>
                  </div>
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Valid from" helper="Blank = immediately.">
                    <input
                      type="date"
                      value={draft.validFrom}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, validFrom: event.target.value }))
                      }
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Valid until" helper="Blank = no expiry.">
                    <input
                      type="date"
                      value={draft.validUntil}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, validUntil: event.target.value }))
                      }
                      className={inputClass}
                    />
                  </Field>
                </div>

                <div className="flex items-center justify-between rounded-xl border border-gray-200 p-4">
                  <div>
                    <p className="text-sm font-medium text-gray-900">Active</p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      Turn off to pause the code without deleting it.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.isActive}
                    onClick={() =>
                      setDraft((current) => ({ ...current, isActive: !current.isActive }))
                    }
                    className={`relative h-6 w-11 rounded-full transition-colors ${draft.isActive ? "bg-primary-600" : "bg-gray-300"}`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${draft.isActive ? "translate-x-5" : "translate-x-0"}`}
                    />
                  </button>
                </div>
              </div>

              <div className="space-y-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Rules &amp; restrictions
                </h3>
                <Field
                  label="Minimum booking value"
                  helper="Code only applies to bookings of this amount or more. Leave blank for no minimum."
                >
                  <div className="relative">
                    <input
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
                      placeholder="e.g. 500"
                      className={`${inputClass} pr-14`}
                    />
                    <span className="absolute right-3 top-2.5 text-sm text-gray-500">
                      {propertyCurrency}
                    </span>
                  </div>
                </Field>

                <Field
                  label="Max uses"
                  helper="Total number of times this code can be redeemed. Use a high number (e.g. 999) for unlimited."
                >
                  <input
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
                  <p className="text-sm font-medium text-gray-800">Applicable rooms</p>
                  <p className="mb-2 mt-1 text-xs text-gray-500">
                    Leave as &apos;All rooms&apos; to apply to any booking, or select specific room
                    types.
                  </p>
                  <details className="group rounded-lg border border-gray-300 bg-white">
                    <summary className="cursor-pointer list-none px-3 py-2.5 text-sm text-gray-900">
                      {draft.applicableRoomIds.length === 0
                        ? "All rooms"
                        : `${draft.applicableRoomIds.length} room${draft.applicableRoomIds.length === 1 ? "" : "s"} selected`}
                    </summary>
                    <div className="max-h-40 space-y-1 overflow-y-auto border-t border-gray-200 p-2">
                      {roomTypes.length === 0 ? (
                        <p className="px-2 py-1 text-xs text-gray-500">No room types available.</p>
                      ) : (
                        roomTypes.map((room) => (
                          <label
                            key={room.roomTypeId}
                            className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
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
                            />
                            {room.name}
                          </label>
                        ))
                      )}
                    </div>
                  </details>
                </div>

                <DateRangeFields
                  legend="Stay dates"
                  helper="Restrict which check-in dates this promo covers, independent of the code's validity period. Leave blank to allow any stay dates."
                  from={draft.stayDateFrom}
                  until={draft.stayDateUntil}
                  onFrom={(value) => setDraft((current) => ({ ...current, stayDateFrom: value }))}
                  onUntil={(value) => setDraft((current) => ({ ...current, stayDateUntil: value }))}
                />
              </div>
            </div>

            {promoError && (
              <div
                role="alert"
                className="mx-6 mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
              >
                {promoError}
              </div>
            )}
            <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-4">
              <button
                type="button"
                onClick={closeEditor}
                className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingPromo}
                className="rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
              >
                {savingPromo ? "Saving..." : editingPromo ? "Save changes" : "Create promo code"}
              </button>
            </div>
          </form>
        </ModalOverlay>
      )}
    </div>
  );
}

const inputClass =
  "h-10 w-full rounded-lg border border-gray-300 px-3 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900";

function ModalOverlay(props: React.ComponentProps<"div">) {
  return createPortal(<div {...props} />, document.body);
}

function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-800">{label}</span>
      <span className="mb-2 mt-1 block text-xs text-gray-500">{helper}</span>
      {children}
    </label>
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
  return (
    <fieldset>
      <legend className="text-sm font-medium text-gray-800">{legend}</legend>
      <p className="mb-2 mt-1 text-xs text-gray-500">{helper}</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-gray-500">
          Stays from
          <input
            type="date"
            value={from}
            onChange={(event) => onFrom(event.target.value)}
            className={`${inputClass} mt-1`}
          />
        </label>
        <label className="text-xs text-gray-500">
          Stays until
          <input
            type="date"
            value={until}
            onChange={(event) => onUntil(event.target.value)}
            className={`${inputClass} mt-1`}
          />
        </label>
      </div>
    </fieldset>
  );
}
