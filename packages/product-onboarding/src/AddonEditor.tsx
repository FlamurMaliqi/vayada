"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

export type AddonPhoto = {
  imageUrl: string;
  mediaObjectId: string | null;
  isCover: boolean;
  file?: File;
};
export type AddonEditorValues = {
  name: string;
  description: string;
  price: string;
  currency: string;
  category: "experience" | "dining" | "wellness" | "transport" | "other";
  duration: string;
  location: string;
  maxGuests: string;
  leadTime: string;
  maxQuantity: string;
  perPerson: boolean;
  perNight: boolean;
  photos: AddonPhoto[];
  ownershipKind: "property" | "partner";
  partnerCommissionRate: string;
};
export function emptyAddonValues(currency: string): AddonEditorValues {
  return {
    name: "",
    description: "",
    price: "",
    currency,
    category: "experience",
    duration: "",
    location: "",
    maxGuests: "",
    leadTime: "",
    maxQuantity: "1",
    perPerson: false,
    perNight: false,
    photos: [],
    ownershipKind: "property",
    partnerCommissionRate: "",
  };
}
const models = [
  [
    "addons.editor.flatFee",
    "addons.editor.fixedPricePerBooking",
    "addons.editor.airportTransfer",
    false,
    false,
  ],
  [
    "addons.editor.perPerson",
    "addons.editor.baseNumberOfGuests",
    "addons.editor.surfLesson",
    true,
    false,
  ],
  [
    "addons.editor.perNight",
    "addons.editor.baseNumberOfNights",
    "addons.editor.parkingBabyCot",
    false,
    true,
  ],
  [
    "addons.editor.perPersonNight",
    "addons.editor.baseGuestsNights",
    "addons.editor.breakfast",
    true,
    true,
  ],
] as const;
const inputClass =
  "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500";

export function AddonEditor({
  translate,
  initialValues,
  currency,
  editing,
  onSave,
  onCancel,
}: {
  translate?: (key: string, params?: Record<string, string | number>) => string;
  initialValues: AddonEditorValues;
  currency: string;
  editing: boolean;
  onSave: (values: AddonEditorValues) => Promise<void> | void;
  onCancel: () => void;
}) {
  const t =
    translate ??
    ((key: string, params?: Record<string, string | number>) => {
      let message = AddonEditorMessages[key as keyof typeof AddonEditorMessages];
      for (const [name, value] of Object.entries(params ?? {}))
        message = message.split(`{${name}}`).join(String(value));
      return message;
    });
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const previews = useRef<string[]>([]);
  useEffect(() => {
    dialog.current?.showModal();
    return () => previews.current.forEach(URL.revokeObjectURL);
  }, []);
  function field(key: keyof AddonEditorValues, label: string, type = "text", placeholder = "") {
    return (
      <label className="block text-xs font-medium text-gray-800">
        {label}
        <input
          type={type}
          value={String(values[key])}
          placeholder={placeholder}
          min={type === "number" ? 1 : undefined}
          step={type === "number" ? 1 : undefined}
          onChange={(e) => {
            setValues((v) => ({ ...v, [key]: e.target.value }));
            setErrors((v) => ({ ...v, [key]: "" }));
          }}
          aria-label={label}
          aria-describedby={errors[key] ? `addon-error-${key}` : undefined}
          aria-invalid={Boolean(errors[key])}
          className={inputClass}
        />
        {errors[key] && (
          <span id={`addon-error-${key}`} role="alert" className="mt-1 block text-red-600">
            {t(errors[key])}
          </span>
        )}
      </label>
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const next: Record<string, string> = {};
    if (!values.name.trim()) next.name = "addons.editor.nameIsRequired";
    if (!/^\d+(?:\.\d{1,2})?$/.test(values.price))
      next.price = "addons.editor.enterANonNegativeBasePriceWithUpToTwo";
    for (const key of ["maxQuantity", "maxGuests"] as const) {
      if (
        (key === "maxQuantity" || values[key]) &&
        (!/^\d+$/.test(values[key]) ||
          !Number.isSafeInteger(Number(values[key])) ||
          Number(values[key]) < 1)
      )
        next[key] = "addons.editor.enterAPositiveWholeNumber";
    }
    if (
      values.ownershipKind === "partner" &&
      !/^(?:100(?:\.0{1,4})?|(?:0|[1-9]\d?)(?:\.\d{1,4})?)$/.test(values.partnerCommissionRate)
    )
      next.partnerCommissionRate = "addons.editor.enterACommissionFrom0To100WithUpTo";
    if (!currency) next.save = "addons.editor.propertyCurrencyIsUnavailablePleaseReload";
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      await onSave({ ...values, name: values.name.trim(), currency });
    } catch {
      setErrors({
        save: "addons.editor.couldNotSaveAddOnPleaseRetry",
      });
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="addon-editor-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onCancel();
      }}
      className="m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-4xl overflow-hidden rounded-2xl bg-white p-0 text-gray-900 shadow-2xl backdrop:bg-black/40"
    >
      <form onSubmit={save} noValidate className="flex max-h-[90vh] flex-col">
        <header className="flex shrink-0 items-start justify-between border-b border-gray-200 p-6">
          <div>
            <h2 id="addon-editor-title" className="text-lg font-semibold">
              {editing ? t("addons.editor.editAddOn") : t("addons.editor.createAddOn")}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {t("addons.editor.upsellsShownDuringTheBookingFlow")}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("addons.editor.closeAddOnEditor")}
            onClick={() => !saving && onCancel()}
            className="rounded-lg border px-2 py-1"
          >
            ×
          </button>
        </header>
        <div className="grid min-h-0 overflow-y-auto md:grid-cols-2">
          <section className="space-y-4 p-6 md:border-r md:border-gray-200">
            <h3 className="text-xs font-semibold tracking-widest text-gray-500">
              {t("addons.editor.what")}
            </h3>
            {field(
              "name",
              t("addons.editor.name"),
              "text",
              t("addons.editor.eGAirportTransferDailyBreakfast"),
            )}
            <label className="block text-xs font-medium">
              {t("addons.editor.description")}
              <textarea
                value={values.description}
                rows={3}
                className={inputClass}
                placeholder={t("addons.editor.whatTheGuestGetsOneOrTwoSentences")}
                onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
              />
            </label>
            <label className="block text-xs font-medium">
              {t("addons.editor.category")}
              <select
                value={values.category}
                className={inputClass}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    category: e.target.value as AddonEditorValues["category"],
                  }))
                }
              >
                {["experience", "dining", "wellness", "transport", "other"].map((c) => (
                  <option key={c} value={c}>
                    {t(`addons.category.${c}`)}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <p className="mb-2 text-xs font-medium">
                {t("addons.editor.photos")}{" "}
                <span className="font-normal text-gray-500">{t("addons.editor.upTo5")}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {values.photos.map((photo, index) => (
                  <div key={photo.imageUrl} className="relative h-20 w-24">
                    <button
                      type="button"
                      aria-label={t("admin.setPhotoNumberAsCover", { number: index + 1 })}
                      aria-pressed={photo.isCover}
                      className="h-full w-full overflow-hidden rounded-lg border"
                      onClick={() =>
                        setValues((v) => ({
                          ...v,
                          photos: v.photos.map((p, i) => ({ ...p, isCover: i === index })),
                        }))
                      }
                    >
                      <img
                        src={photo.imageUrl}
                        alt={t("admin.addOnPhotoNumber", { number: index + 1 })}
                        className="h-full w-full object-cover"
                      />
                      {photo.isCover && (
                        <span className="absolute bottom-1 left-1 rounded bg-primary-600 px-1 text-[10px] text-white">
                          {t("addons.editor.cover")}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={t("admin.removePhotoNumber", { number: index + 1 })}
                      className="absolute right-1 top-1 rounded bg-gray-900 px-1 text-white"
                      onClick={() =>
                        setValues((v) => {
                          const photos = v.photos.filter((_, i) => i !== index);
                          if (photos.length && !photos.some((p) => p.isCover))
                            photos[0] = { ...photos[0], isCover: true };
                          return { ...v, photos };
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                {values.photos.length < 5 && (
                  <label className="flex h-20 w-24 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed text-xs text-gray-500">
                    +<span>{t("addons.editor.add")}</span>
                    <input
                      type="file"
                      multiple
                      accept="image/jpeg,image/png,image/webp"
                      aria-label={t("addons.editor.addPhotos")}
                      className="sr-only"
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = "";
                        if (files.length + values.photos.length > 5) {
                          setErrors((e) => ({
                            ...e,
                            photos: "addons.editor.photoLimit",
                          }));
                          return;
                        }
                        if (
                          files.some(
                            (file) =>
                              !["image/jpeg", "image/png", "image/webp"].includes(file.type),
                          )
                        ) {
                          setErrors((e) => ({ ...e, photos: "addons.editor.photoFormat" }));
                          return;
                        }
                        const added = files.map((file) => {
                          const imageUrl = URL.createObjectURL(file);
                          previews.current.push(imageUrl);
                          return { file, imageUrl, mediaObjectId: null, isCover: false };
                        });
                        setValues((v) => ({
                          ...v,
                          photos: [...v.photos, ...added].map((p, i) => ({
                            ...p,
                            isCover: v.photos.length ? p.isCover : i === 0,
                          })),
                        }));
                        setErrors((e) => ({ ...e, photos: "" }));
                      }}
                    />
                  </label>
                )}
              </div>
              {errors.photos && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {t(errors.photos)}
                </p>
              )}
            </div>
            <h3 className="pt-2 text-xs font-semibold tracking-widest text-gray-500">
              {t("addons.editor.details")}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {field("duration", t("addons.editor.duration"), "text", t("addons.editor.eG2Hours"))}
              {field(
                "location",
                t("addons.editor.location"),
                "text",
                t("addons.editor.eGHotelLobby"),
              )}
              {field("maxGuests", t("addons.editor.maxGuests"), "number", t("addons.editor.eG6"))}
              {field(
                "leadTime",
                t("addons.editor.leadTime"),
                "text",
                t("addons.editor.eG24hBefore"),
              )}
            </div>
          </section>
          <section className="space-y-4 p-6">
            <h3 className="text-xs font-semibold tracking-widest text-gray-500">
              {t("addons.editor.pricing")}
            </h3>
            <fieldset>
              <legend className="mb-2 text-xs font-medium">
                {t("addons.editor.pricingModel")}
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {models.map(([label, description, example, perPerson, perNight]) => (
                  <label
                    key={label}
                    className={`relative cursor-pointer rounded-lg border p-3 text-xs focus-within:ring-2 focus-within:ring-primary-500 ${values.perPerson === perPerson && values.perNight === perNight ? "border-primary-500 bg-primary-50" : "border-gray-200"}`}
                  >
                    <input
                      type="radio"
                      name="addon-pricing-model"
                      aria-label={t(label)}
                      className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                      checked={values.perPerson === perPerson && values.perNight === perNight}
                      onChange={() => setValues((v) => ({ ...v, perPerson, perNight }))}
                    />
                    <span className="block font-semibold">{t(label)}</span>
                    <span className="mt-1 block text-gray-500">{t(description)}</span>
                    <span className="mt-1 block italic text-gray-400">{t(example)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-2 gap-3">
              {field("price", t("admin.basePriceCurrency", { currency }), "text", "0.00")}
              {field("maxQuantity", t("addons.editor.maxQuantity"), "number")}
            </div>
            <p className="text-xs text-gray-500">
              {t("addons.editor.maxQuantityIsTheNumberOfPackagesPerBooking")}
            </p>
            <label className="block text-xs font-medium">
              {t("addons.editor.ownership")}
              <select
                value={values.ownershipKind}
                className={inputClass}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    ownershipKind: e.target.value as "property" | "partner",
                  }))
                }
              >
                <option value="property">{t("addons.editor.own")}</option>
                <option value="partner">{t("addons.editor.partner")}</option>
              </select>
            </label>
            {values.ownershipKind === "partner" &&
              field("partnerCommissionRate", t("addons.editor.partnerCommission"))}
          </section>
        </div>
        <footer className="shrink-0 border-t border-gray-200 p-6">
          {errors.save && (
            <p role="alert" className="mb-3 text-sm text-red-600">
              {t(errors.save)}
            </p>
          )}
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => !saving && onCancel()}
              className="rounded-lg border px-4 py-2 text-sm"
            >
              {t("addons.editor.cancel")}
            </button>
            <button
              type="submit"
              aria-busy={saving}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white"
            >
              {saving
                ? t("addons.editor.saving")
                : editing
                  ? t("addons.editor.save")
                  : t("addons.editor.createAddOn")}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}

export const AddonEditorMessages = {
  "addons.editor.photoLimit": "Choose up to five photos in total.",
  "addons.editor.photoFormat": "Choose JPEG, PNG, or WebP images.",
  "addons.category.other": "Other",
  "addons.category.transport": "Transport",
  "addons.category.wellness": "Wellness",
  "addons.category.dining": "Dining",
  "addons.category.experience": "Experience",
  "admin.basePriceCurrency": "Base price ({currency}) *",
  "admin.removePhotoNumber": "Remove photo {number}",
  "admin.addOnPhotoNumber": "Add-on photo {number}",
  "admin.setPhotoNumberAsCover": "Set photo {number} as cover",
  "addons.editor.flatFee": "Flat fee",
  "addons.editor.fixedPricePerBooking": "Fixed price per booking",
  "addons.editor.airportTransfer": "Airport transfer",
  "addons.editor.perPerson": "Per person",
  "addons.editor.baseNumberOfGuests": "Base × number of guests",
  "addons.editor.surfLesson": "Surf lesson",
  "addons.editor.perNight": "Per night",
  "addons.editor.baseNumberOfNights": "Base × number of nights",
  "addons.editor.parkingBabyCot": "Parking, baby cot",
  "addons.editor.perPersonNight": "Per person / night",
  "addons.editor.baseGuestsNights": "Base × guests × nights",
  "addons.editor.breakfast": "Breakfast",
  "addons.editor.nameIsRequired": "Name is required.",
  "addons.editor.enterANonNegativeBasePriceWithUpToTwo":
    "Enter a non-negative base price with up to two decimals.",
  "addons.editor.enterAPositiveWholeNumber": "Enter a positive whole number.",
  "addons.editor.enterACommissionFrom0To100WithUpTo":
    "Enter a commission from 0 to 100 with up to four decimals.",
  "addons.editor.propertyCurrencyIsUnavailablePleaseReload":
    "Property currency is unavailable. Please reload.",
  "addons.editor.couldNotSaveAddOnPleaseRetry": "Could not save add-on. Please retry.",
  "addons.editor.editAddOn": "Edit Add-on",
  "addons.editor.createAddOn": "Create Add-on",
  "addons.editor.upsellsShownDuringTheBookingFlow": "Upsells shown during the booking flow.",
  "addons.editor.closeAddOnEditor": "Close add-on editor",
  "addons.editor.what": "WHAT",
  "addons.editor.name": "Name *",
  "addons.editor.eGAirportTransferDailyBreakfast": "e.g., Airport Transfer, Daily Breakfast",
  "addons.editor.description": "Description",
  "addons.editor.whatTheGuestGetsOneOrTwoSentences": "What the guest gets, one or two sentences.",
  "addons.editor.category": "Category",
  "addons.editor.photos": "Photos",
  "addons.editor.upTo5": "Up to 5",
  "addons.editor.cover": "COVER",
  "addons.editor.add": "Add",
  "addons.editor.addPhotos": "Add photos",
  "addons.editor.details": "DETAILS",
  "addons.editor.duration": "Duration",
  "addons.editor.eG2Hours": "e.g., 2 hours",
  "addons.editor.location": "Location",
  "addons.editor.eGHotelLobby": "e.g., Hotel lobby",
  "addons.editor.maxGuests": "Max guests",
  "addons.editor.eG6": "e.g., 6",
  "addons.editor.leadTime": "Lead time",
  "addons.editor.eG24hBefore": "e.g., 24h before",
  "addons.editor.pricing": "PRICING",
  "addons.editor.pricingModel": "Pricing model *",
  "addons.editor.maxQuantity": "Max quantity",
  "addons.editor.maxQuantityIsTheNumberOfPackagesPerBooking":
    "Max quantity is the number of packages per booking.",
  "addons.editor.ownership": "Ownership",
  "addons.editor.own": "Own",
  "addons.editor.partner": "Partner",
  "addons.editor.partnerCommission": "Partner commission (%)",
  "addons.editor.cancel": "Cancel",
  "addons.editor.saving": "Saving...",
  "addons.editor.save": "Save",
};
