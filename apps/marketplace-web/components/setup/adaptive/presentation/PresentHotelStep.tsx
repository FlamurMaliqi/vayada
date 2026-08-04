"use client";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  PhotoIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  HOTEL_CATALOG_AMENITIES,
  HOTEL_CATALOG_CONTENT_LOCALES,
  HOTEL_CATALOG_STEP1_SUMMARY_MAX_LENGTH,
  HOTEL_CATALOG_STEP1_SUMMARY_MIN_LENGTH,
  hotelCatalogAmenityLabel,
  type HotelCatalogAmenityKey,
  type HotelCatalogContentLocale,
  type HotelCatalogStep1ReadModel,
} from "@vayada/domain-hotels";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
import {
  AdaptiveSaveError,
  AdaptiveStepCard,
  AdaptiveStepSkeleton,
  adaptivePrimaryButtonClass,
  adaptiveSecondaryButtonClass,
} from "../AdaptiveStepPrimitives";
import {
  adaptiveStepDraftRevision,
  adaptiveStepErrorMessage,
  draftRequest,
  exactSourceRevision,
  isAdaptiveRevisionConflict,
  withDraftReceipt,
} from "../adaptiveSetupStepState";
import { adaptiveSetupDraftClient } from "@/services/api/adaptiveSetupDraftClient";
import { hotelPresentationClient } from "@/services/api/hotelPresentationClient";

type PhotoDraft = {
  key: string;
  mediaObjectId: string | null;
  previewUrl: string | null;
  filename: string;
  file?: File;
  status: "ready" | "uploading" | "failed";
  error?: string;
};

type PresentationForm = {
  locale: HotelCatalogContentLocale | "";
  summary: string;
  photos: PhotoDraft[];
  coverMediaObjectId: string | null;
  amenities: HotelCatalogAmenityKey[];
};

type Errors = Partial<Record<"locale" | "summary" | "uploads", string>>;

const LOCALE_LABELS: Record<HotelCatalogContentLocale, string> = {
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  nl: "Dutch",
  ru: "Russian",
  zh: "Chinese",
};
const AMENITY_KEYS = Object.keys(HOTEL_CATALOG_AMENITIES) as HotelCatalogAmenityKey[];
const PRESENTATION_FIELDS = [
  "profile.default_locale",
  "profile.short_description",
  "profile.hero_image",
  "profile.gallery_images",
  "profile.amenities",
] as const;

export function PresentHotelStep(props: AdaptiveSetupStepComponentProps) {
  const {
    propertyId,
    route,
    step,
    registerBeforeLeave,
    refreshRoute,
    saveAndContinue,
    reportRevisionConflict,
  } = props;
  const [form, setForm] = useState<PresentationForm | null>(null);
  const formRef = useRef<PresentationForm | null>(null);
  const [owner, setOwner] = useState<HotelCatalogStep1ReadModel | null>(null);
  const ownerRef = useRef<HotelCatalogStep1ReadModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [amenitiesOpen, setAmenitiesOpen] = useState(false);
  const [amenitySearch, setAmenitySearch] = useState("");
  const [reload, setReload] = useState(0);
  const dirtyRef = useRef(false);
  const revisionRef = useRef(adaptiveStepDraftRevision(route, step, "present_hotel"));
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const localeRef = useRef<HTMLSelectElement>(null);

  useEffect(
    () => () => {
      for (const photo of formRef.current?.photos ?? []) {
        if (photo.previewUrl) URL.revokeObjectURL(photo.previewUrl);
      }
    },
    [],
  );

  useEffect(() => {
    const next = adaptiveStepDraftRevision(route, step, "present_hotel");
    if (next.baseRevisions || next.draftRevision > revisionRef.current.draftRevision) {
      revisionRef.current = next;
    }
  }, [route, step]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void hotelPresentationClient
      .load(propertyId, { signal: controller.signal, cache: "no-store" })
      .then((read) => {
        if (controller.signal.aborted) return;
        const next = hydrate(read, step.draft);
        ownerRef.current = read;
        formRef.current = next;
        setOwner(read);
        setForm(next);
        dirtyRef.current = false;
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoadError(adaptiveStepErrorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // Reload is explicit; local changes never trigger an owner refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, reload]);

  const update = useCallback((change: Partial<PresentationForm>) => {
    const current = formRef.current;
    if (!current) return;
    const next = { ...current, ...change };
    formRef.current = next;
    dirtyRef.current = true;
    setForm(next);
  }, []);

  const persistDraft = useCallback(async () => {
    const current = formRef.current;
    if (!current || !dirtyRef.current) return;
    const receipt = await adaptiveSetupDraftClient.save(
      propertyId,
      draftRequest(revisionRef.current, {
        stepId: "present_hotel",
        payload: {
          "profile.default_locale": current.locale,
          "profile.short_description": current.summary,
          "profile.hero_image": current.coverMediaObjectId,
          "profile.gallery_images": readyMediaIds(current).filter(
            (mediaObjectId) => mediaObjectId !== current.coverMediaObjectId,
          ),
          "profile.amenities": current.amenities,
        },
        dirtyFields: [...PRESENTATION_FIELDS],
      }),
    );
    revisionRef.current = withDraftReceipt(revisionRef.current, receipt);
    dirtyRef.current = false;
    setSaveError(null);
  }, [propertyId]);

  useEffect(
    () =>
      registerBeforeLeave(async () => {
        try {
          await persistDraft();
          await refreshRoute();
        } catch (error) {
          setSaveError(adaptiveStepErrorMessage(error));
          throw error;
        }
      }),
    [persistDraft, refreshRoute, registerBeforeLeave],
  );

  const uploadPhotos = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!formRef.current || files.length === 0) return;
    try {
      // Establish a durable, exact-manifest draft boundary before external uploads.
      dirtyRef.current = true;
      await persistDraft();
    } catch (error) {
      setSaveError(adaptiveStepErrorMessage(error));
      return;
    }
    const placeholders = files.map<PhotoDraft>((file) => ({
      key: crypto.randomUUID(),
      mediaObjectId: null,
      previewUrl: URL.createObjectURL(file),
      filename: file.name || "Hotel photo",
      file,
      status: "uploading",
    }));
    update({ photos: [...formRef.current.photos, ...placeholders] });
    await Promise.all(
      files.map(async (file, index) => {
        const placeholder = placeholders[index]!;
        await uploadPhoto(placeholder, file);
      }),
    );
    try {
      await persistDraft();
    } catch (error) {
      setSaveError(adaptiveStepErrorMessage(error));
    }
  };

  const uploadPhoto = async (photo: PhotoDraft, file: File) => {
    replacePhoto(photo.key, { ...photo, file, status: "uploading", error: undefined });
    try {
      const [uploaded] = await hotelPresentationClient.upload(propertyId, [file]);
      if (!uploaded) throw new Error("The uploaded photo was not returned.");
      replacePhoto(photo.key, {
        ...photo,
        file,
        mediaObjectId: uploaded.mediaObjectId,
        status: "ready",
        error: undefined,
      });
    } catch (error) {
      replacePhoto(photo.key, {
        ...photo,
        file,
        status: "failed",
        error: adaptiveStepErrorMessage(error),
      });
    }
  };

  const replacePhoto = (key: string, photo: PhotoDraft) => {
    const current = formRef.current;
    if (!current) return;
    const photos = current.photos.map((item) => (item.key === key ? photo : item));
    const coverMediaObjectId =
      current.coverMediaObjectId ??
      photos.find(({ mediaObjectId }) => mediaObjectId)?.mediaObjectId ??
      null;
    update({ photos, coverMediaObjectId });
  };

  const removePhoto = (key: string) => {
    const current = formRef.current;
    if (!current) return;
    const removed = current.photos.find((photo) => photo.key === key);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    const photos = current.photos.filter((photo) => photo.key !== key);
    const coverMediaObjectId = photos.some(
      ({ mediaObjectId }) => mediaObjectId === current.coverMediaObjectId,
    )
      ? current.coverMediaObjectId
      : (photos.find(({ mediaObjectId }) => mediaObjectId)?.mediaObjectId ?? null);
    update({ photos, coverMediaObjectId });
  };

  const movePhoto = (index: number, direction: -1 | 1) => {
    const current = formRef.current;
    if (!current) return;
    const target = index + direction;
    if (target < 0 || target >= current.photos.length) return;
    const photos = current.photos.slice();
    [photos[index], photos[target]] = [photos[target]!, photos[index]!];
    update({ photos });
  };

  const validate = (current: PresentationForm): Errors => {
    const next: Errors = {};
    if (!current.locale) next.locale = "Choose the language used for this public summary.";
    const trimmed = current.summary.trim();
    if (trimmed.length < HOTEL_CATALOG_STEP1_SUMMARY_MIN_LENGTH) {
      next.summary = `Write at least ${HOTEL_CATALOG_STEP1_SUMMARY_MIN_LENGTH} characters.`;
    } else if (trimmed.length > HOTEL_CATALOG_STEP1_SUMMARY_MAX_LENGTH) {
      next.summary = `Keep the summary within ${HOTEL_CATALOG_STEP1_SUMMARY_MAX_LENGTH} characters.`;
    }
    if (current.photos.some(({ status }) => status === "uploading")) {
      next.uploads = "Wait for active uploads to finish, or remove them.";
    }
    return next;
  };

  const continueSetup = async () => {
    const current = formRef.current;
    const read = ownerRef.current;
    if (!current || !read) return;
    const nextErrors = validate(current);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      if (nextErrors.locale) localeRef.current?.focus();
      else if (nextErrors.summary) summaryRef.current?.focus();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await persistDraft();
      const base = revisionRef.current.baseRevisions;
      const profileRevision = base
        ? exactSourceRevision(base["hotel_catalog.profile"], "profile")
        : null;
      if (
        !base ||
        profileRevision === null ||
        Object.values(base).some((source) => source !== `profile:${profileRevision}`) ||
        Object.values(read.baseRevisions).some((source) => source !== `profile:${profileRevision}`)
      ) {
        throw new RevisionMismatchError();
      }
      const mediaIds = readyMediaIds(current);
      const saved = await hotelPresentationClient.save(propertyId, {
        expectedProfileRevision: profileRevision,
        locale: current.locale as HotelCatalogContentLocale,
        shortDescription: current.summary,
        amenities: { reviewed: true, keys: current.amenities },
        media: {
          coverMediaObjectId: current.coverMediaObjectId,
          galleryMediaObjectIds: mediaIds.filter((id) => id !== current.coverMediaObjectId),
        },
      });
      ownerRef.current = saved;
      setOwner(saved);
      await saveAndContinue();
    } catch (error) {
      if (error instanceof RevisionMismatchError || isAdaptiveRevisionConflict(error)) {
        reportRevisionConflict();
      } else {
        setSaveError(adaptiveStepErrorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  };

  const filteredAmenities = useMemo(() => {
    const query = amenitySearch.trim().toLocaleLowerCase();
    return AMENITY_KEYS.filter(
      (key) => !query || hotelCatalogAmenityLabel(key).toLocaleLowerCase().includes(query),
    );
  }, [amenitySearch]);

  if (loading) return <AdaptiveStepSkeleton />;
  if (loadError || !form || !owner) {
    return (
      <div className="mx-auto max-w-5xl">
        <AdaptiveSaveError
          message={loadError ?? "The hotel profile could not be loaded."}
          onRetry={() => setReload((value) => value + 1)}
        />
      </div>
    );
  }

  return (
    <form
      className="mx-auto max-w-5xl"
      onSubmit={(event) => {
        event.preventDefault();
        void continueSetup();
      }}
      noValidate
    >
      {saveError && <AdaptiveSaveError message={saveError} onRetry={() => void continueSetup()} />}
      <AdaptiveStepCard>
        <div className="grid gap-6 sm:grid-cols-2">
          <label className="block sm:max-w-sm">
            <span className="text-sm font-semibold text-gray-900">Content language *</span>
            <select
              ref={localeRef}
              value={form.locale}
              onChange={(event) => {
                update({ locale: event.target.value as HotelCatalogContentLocale });
                setErrors((value) => ({ ...value, locale: undefined }));
              }}
              aria-invalid={!!errors.locale}
              aria-describedby={errors.locale ? "presentation-locale-error" : undefined}
              className="mt-2 min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm outline-none focus:border-primary-600 focus:ring-2 focus:ring-primary-100"
            >
              <option value="">Select language…</option>
              {owner.supportedLocales.map((locale) => (
                <option key={locale} value={locale}>
                  {LOCALE_LABELS[locale]}
                </option>
              ))}
            </select>
            {errors.locale && (
              <p id="presentation-locale-error" className="mt-1 text-sm text-red-700">
                {errors.locale}
              </p>
            )}
          </label>
        </div>

        <label className="mt-6 block">
          <span className="text-sm font-semibold text-gray-900">Short hotel summary *</span>
          <textarea
            ref={summaryRef}
            rows={5}
            maxLength={HOTEL_CATALOG_STEP1_SUMMARY_MAX_LENGTH}
            value={form.summary}
            onChange={(event) => {
              update({ summary: event.target.value });
              setErrors((value) => ({ ...value, summary: undefined }));
            }}
            aria-invalid={!!errors.summary}
            aria-describedby={`presentation-summary-help${errors.summary ? " presentation-summary-error" : ""}`}
            placeholder="Describe what guests can expect from your hotel, location, and atmosphere."
            className="mt-2 w-full resize-y rounded-xl border border-gray-300 px-3 py-3 text-sm leading-6 outline-none focus:border-primary-600 focus:ring-2 focus:ring-primary-100"
          />
        </label>
        <div className="mt-1 flex items-start justify-between gap-4 text-sm">
          <p id="presentation-summary-help" className="text-gray-500">
            Describe the location, atmosphere, and what makes a stay special.
          </p>
          <p className="shrink-0 tabular-nums text-gray-600" aria-live="polite">
            {form.summary.length} / {HOTEL_CATALOG_STEP1_SUMMARY_MAX_LENGTH}
          </p>
        </div>
        {errors.summary && (
          <p id="presentation-summary-error" className="mt-1 text-sm text-red-700">
            {errors.summary}
          </p>
        )}

        <section
          className="mt-8 border-t border-gray-100 pt-7"
          aria-labelledby="hotel-photos-heading"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="hotel-photos-heading" className="text-sm font-semibold text-gray-900">
                Hotel photos
              </h2>
              <p className="mt-1 text-sm text-gray-500">Recommended · The cover is shown first.</p>
            </div>
            <label className={`${adaptiveSecondaryButtonClass} cursor-pointer gap-2`}>
              <PhotoIcon className="h-5 w-5" aria-hidden="true" /> Upload photos
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="sr-only"
                onChange={(event) => void uploadPhotos(event)}
              />
            </label>
          </div>
          {form.photos.length > 0 && (
            <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {form.photos.map((photo, index) => (
                <li
                  key={photo.key}
                  className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50"
                >
                  <div className="relative aspect-[4/3] bg-gray-100">
                    {photo.previewUrl ? (
                      // Object URLs and private upload previews cannot use the Next image optimizer.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={photo.previewUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <PhotoIcon className="h-8 w-8 text-gray-400" aria-hidden="true" />
                      </div>
                    )}
                    {photo.mediaObjectId === form.coverMediaObjectId && (
                      <span className="absolute left-2 top-2 rounded-full bg-gray-950/85 px-2 py-1 text-xs font-semibold text-white">
                        Cover
                      </span>
                    )}
                    {photo.status === "uploading" && (
                      <span
                        className="absolute inset-0 flex items-center justify-center bg-white/85 text-xs font-semibold text-gray-800"
                        role="status"
                      >
                        Uploading…
                      </span>
                    )}
                  </div>
                  <div className="p-2">
                    <p className="truncate text-xs font-medium text-gray-700">{photo.filename}</p>
                    {photo.status === "failed" && (
                      <p className="mt-1 text-xs text-red-700" role="alert">
                        {photo.error ?? "Upload failed"}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {photo.status === "failed" && photo.file && (
                        <button
                          type="button"
                          onClick={() => void uploadPhoto(photo, photo.file!)}
                          className="rounded px-2 py-1 text-xs font-semibold text-primary-700 outline-none hover:bg-primary-50 focus-visible:ring-2 focus-visible:ring-primary-600"
                        >
                          Retry
                        </button>
                      )}
                      {photo.mediaObjectId && photo.mediaObjectId !== form.coverMediaObjectId && (
                        <button
                          type="button"
                          onClick={() => update({ coverMediaObjectId: photo.mediaObjectId })}
                          className="rounded px-2 py-1 text-xs font-semibold text-primary-700 outline-none hover:bg-primary-50 focus-visible:ring-2 focus-visible:ring-primary-600"
                        >
                          Make cover
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => movePhoto(index, -1)}
                        aria-label={`Move ${photo.filename} earlier`}
                        className="rounded p-1 text-gray-600 outline-none hover:bg-white focus-visible:ring-2 focus-visible:ring-primary-600 disabled:opacity-30"
                      >
                        <ArrowLeftIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        disabled={index === form.photos.length - 1}
                        onClick={() => movePhoto(index, 1)}
                        aria-label={`Move ${photo.filename} later`}
                        className="rounded p-1 text-gray-600 outline-none hover:bg-white focus-visible:ring-2 focus-visible:ring-primary-600 disabled:opacity-30"
                      >
                        <ArrowRightIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removePhoto(photo.key)}
                        aria-label={`Remove ${photo.filename}`}
                        className="ml-auto rounded p-1 text-red-700 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-700"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {errors.uploads && (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {errors.uploads}
            </p>
          )}
        </section>

        <section className="mt-8 border-t border-gray-100 pt-7">
          <button
            type="button"
            aria-expanded={amenitiesOpen}
            onClick={() => setAmenitiesOpen((value) => !value)}
            className="flex min-h-11 w-full items-center justify-between rounded-xl px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
          >
            <span>
              <span className="block text-sm font-semibold text-gray-900">Add amenities</span>
              <span className="mt-1 block text-sm text-gray-500">
                Recommended ·{" "}
                {form.amenities.length ? `${form.amenities.length} selected` : "Optional"}
              </span>
            </span>
            <ChevronDownIcon
              className={`h-5 w-5 text-gray-500 transition ${amenitiesOpen ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
          </button>
          {amenitiesOpen && (
            <div className="mt-4">
              <label className="block">
                <span className="sr-only">Search amenities</span>
                <input
                  type="search"
                  value={amenitySearch}
                  onChange={(event) => setAmenitySearch(event.target.value)}
                  placeholder="Search amenities"
                  className="min-h-11 w-full max-w-sm rounded-xl border border-gray-300 px-3 text-sm outline-none focus:border-primary-600 focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {filteredAmenities.map((key) => {
                  const checked = form.amenities.includes(key);
                  return (
                    <label
                      key={key}
                      className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm outline-none ${checked ? "border-primary-500 bg-primary-50 text-primary-950" : "border-gray-200 text-gray-700 hover:bg-gray-50"}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          update({
                            amenities: checked
                              ? form.amenities.filter((item) => item !== key)
                              : [...form.amenities, key],
                          })
                        }
                        className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
                      />
                      {checked && (
                        <CheckCircleIcon className="h-4 w-4 text-primary-600" aria-hidden="true" />
                      )}
                      <span>{hotelCatalogAmenityLabel(key)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </AdaptiveStepCard>
      <div className="mt-5 flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className={`${adaptivePrimaryButtonClass} w-full sm:w-auto`}
        >
          {saving ? "Saving…" : "Save and continue"}
        </button>
      </div>
    </form>
  );
}

function hydrate(
  owner: HotelCatalogStep1ReadModel,
  routeDraft: AdaptiveSetupStepComponentProps["step"]["draft"],
): PresentationForm {
  const draft = routeDraft?.stepId === "present_hotel" ? routeDraft : null;
  const dirty = new Set(draft?.dirtyFields ?? []);
  const payload = draft?.payload ?? {};
  const locale =
    dirty.has("profile.default_locale") && isLocale(payload["profile.default_locale"])
      ? payload["profile.default_locale"]
      : owner.profile.locale;
  const summary =
    dirty.has("profile.short_description") &&
    typeof payload["profile.short_description"] === "string"
      ? payload["profile.short_description"]
      : (owner.profile.shortDescription ?? "");
  const ownerIds = [
    owner.profile.media.coverMediaObjectId,
    ...owner.profile.media.galleryMediaObjectIds,
  ].filter((value): value is string => !!value);
  const cover =
    dirty.has("profile.hero_image") &&
    (typeof payload["profile.hero_image"] === "string" || payload["profile.hero_image"] === null)
      ? payload["profile.hero_image"]
      : owner.profile.media.coverMediaObjectId;
  const gallery =
    dirty.has("profile.gallery_images") && stringArray(payload["profile.gallery_images"])
      ? payload["profile.gallery_images"]
      : owner.profile.media.galleryMediaObjectIds;
  const ids = Array.from(new Set([cover, ...gallery].filter((value): value is string => !!value)));
  const amenities =
    dirty.has("profile.amenities") && amenityArray(payload["profile.amenities"])
      ? payload["profile.amenities"]
      : owner.profile.amenities.keys;
  return {
    locale,
    summary,
    coverMediaObjectId: cover,
    amenities,
    photos: (ids.length ? ids : ownerIds).map((mediaObjectId, index) => ({
      key: mediaObjectId,
      mediaObjectId,
      previewUrl: null,
      filename: index === 0 ? "Saved hotel cover" : `Saved hotel photo ${index + 1}`,
      status: "ready",
    })),
  };
}

function readyMediaIds(form: PresentationForm): string[] {
  return form.photos.flatMap((photo) =>
    photo.status === "ready" && photo.mediaObjectId ? [photo.mediaObjectId] : [],
  );
}
function isLocale(value: unknown): value is HotelCatalogContentLocale {
  return HOTEL_CATALOG_CONTENT_LOCALES.includes(value as HotelCatalogContentLocale);
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function amenityArray(value: unknown): value is HotelCatalogAmenityKey[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && Object.hasOwn(HOTEL_CATALOG_AMENITIES, item))
  );
}
class RevisionMismatchError extends Error {}
