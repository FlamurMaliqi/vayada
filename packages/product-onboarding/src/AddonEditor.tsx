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
  ["Flat fee", "Fixed price per booking", "Airport transfer", false, false],
  ["Per person", "Base × number of guests", "Surf lesson", true, false],
  ["Per night", "Base × number of nights", "Parking, baby cot", false, true],
  ["Per person / night", "Base × guests × nights", "Breakfast", true, true],
] as const;
const inputClass =
  "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500";

export function AddonEditor({
  initialValues,
  currency,
  editing,
  onSave,
  onCancel,
}: {
  initialValues: AddonEditorValues;
  currency: string;
  editing: boolean;
  onSave: (values: AddonEditorValues) => Promise<void> | void;
  onCancel: () => void;
}) {
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
            {errors[key]}
          </span>
        )}
      </label>
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const next: Record<string, string> = {};
    if (!values.name.trim()) next.name = "Name is required.";
    if (!/^\d+(?:\.\d{1,2})?$/.test(values.price))
      next.price = "Enter a non-negative base price with up to two decimals.";
    for (const key of ["maxQuantity", "maxGuests"] as const) {
      if (
        (key === "maxQuantity" || values[key]) &&
        (!/^\d+$/.test(values[key]) ||
          !Number.isSafeInteger(Number(values[key])) ||
          Number(values[key]) < 1)
      )
        next[key] = "Enter a positive whole number.";
    }
    if (
      values.ownershipKind === "partner" &&
      !/^(?:100(?:\.0{1,4})?|(?:0|[1-9]\d?)(?:\.\d{1,4})?)$/.test(values.partnerCommissionRate)
    )
      next.partnerCommissionRate = "Enter a commission from 0 to 100 with up to four decimals.";
    if (!currency) next.save = "Property currency is unavailable. Please reload.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      await onSave({ ...values, name: values.name.trim(), currency });
    } catch (error) {
      setErrors({
        save: error instanceof Error ? error.message : "Could not save add-on. Please retry.",
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
              {editing ? "Edit Add-on" : "Create Add-on"}
            </h2>
            <p className="mt-1 text-sm text-gray-500">Upsells shown during the booking flow.</p>
          </div>
          <button
            type="button"
            aria-label="Close add-on editor"
            onClick={() => !saving && onCancel()}
            className="rounded-lg border px-2 py-1"
          >
            ×
          </button>
        </header>
        <div className="grid min-h-0 overflow-y-auto md:grid-cols-2">
          <section className="space-y-4 p-6 md:border-r md:border-gray-200">
            <h3 className="text-xs font-semibold tracking-widest text-gray-500">WHAT</h3>
            {field("name", "Name *", "text", "e.g., Airport Transfer, Daily Breakfast")}
            <label className="block text-xs font-medium">
              Description
              <textarea
                value={values.description}
                rows={3}
                className={inputClass}
                placeholder="What the guest gets, one or two sentences."
                onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
              />
            </label>
            <label className="block text-xs font-medium">
              Category
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
                    {c[0].toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <p className="mb-2 text-xs font-medium">
                Photos <span className="font-normal text-gray-500">Up to 5</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {values.photos.map((photo, index) => (
                  <div key={photo.imageUrl} className="relative h-20 w-24">
                    <button
                      type="button"
                      aria-label={`Set photo ${index + 1} as cover`}
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
                        alt={`Add-on photo ${index + 1}`}
                        className="h-full w-full object-cover"
                      />
                      {photo.isCover && (
                        <span className="absolute bottom-1 left-1 rounded bg-primary-600 px-1 text-[10px] text-white">
                          COVER
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove photo ${index + 1}`}
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
                    +<span>Add</span>
                    <input
                      type="file"
                      multiple
                      accept="image/jpeg,image/png,image/webp"
                      aria-label="Add photos"
                      className="sr-only"
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = "";
                        if (files.length + values.photos.length > 5) {
                          setErrors((e) => ({
                            ...e,
                            photos: "Choose up to five photos in total.",
                          }));
                          return;
                        }
                        if (
                          files.some(
                            (file) =>
                              !["image/jpeg", "image/png", "image/webp"].includes(file.type),
                          )
                        ) {
                          setErrors((e) => ({ ...e, photos: "Choose JPEG, PNG, or WebP images." }));
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
                  {errors.photos}
                </p>
              )}
            </div>
            <h3 className="pt-2 text-xs font-semibold tracking-widest text-gray-500">DETAILS</h3>
            <div className="grid grid-cols-2 gap-3">
              {field("duration", "Duration", "text", "e.g., 2 hours")}
              {field("location", "Location", "text", "e.g., Hotel lobby")}
              {field("maxGuests", "Max guests", "number", "e.g., 6")}
              {field("leadTime", "Lead time", "text", "e.g., 24h before")}
            </div>
          </section>
          <section className="space-y-4 p-6">
            <h3 className="text-xs font-semibold tracking-widest text-gray-500">PRICING</h3>
            <fieldset>
              <legend className="mb-2 text-xs font-medium">Pricing model *</legend>
              <div className="grid grid-cols-2 gap-2">
                {models.map(([label, description, example, perPerson, perNight]) => (
                  <label
                    key={label}
                    className={`relative cursor-pointer rounded-lg border p-3 text-xs focus-within:ring-2 focus-within:ring-primary-500 ${values.perPerson === perPerson && values.perNight === perNight ? "border-primary-500 bg-primary-50" : "border-gray-200"}`}
                  >
                    <input
                      type="radio"
                      name="addon-pricing-model"
                      aria-label={label}
                      className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                      checked={values.perPerson === perPerson && values.perNight === perNight}
                      onChange={() => setValues((v) => ({ ...v, perPerson, perNight }))}
                    />
                    <span className="block font-semibold">{label}</span>
                    <span className="mt-1 block text-gray-500">{description}</span>
                    <span className="mt-1 block italic text-gray-400">{example}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-2 gap-3">
              {field("price", `Base price (${currency}) *`, "text", "0.00")}
              {field("maxQuantity", "Max quantity", "number")}
            </div>
            <p className="text-xs text-gray-500">
              Max quantity is the number of packages per booking.
            </p>
            <label className="block text-xs font-medium">
              Ownership
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
                <option value="property">Own</option>
                <option value="partner">Partner</option>
              </select>
            </label>
            {values.ownershipKind === "partner" &&
              field("partnerCommissionRate", "Partner commission (%)")}
          </section>
        </div>
        <footer className="shrink-0 border-t border-gray-200 p-6">
          {errors.save && (
            <p role="alert" className="mb-3 text-sm text-red-600">
              {errors.save}
            </p>
          )}
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => !saving && onCancel()}
              className="rounded-lg border px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              aria-busy={saving}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white"
            >
              {saving ? "Saving..." : editing ? "Save" : "Create Add-on"}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
