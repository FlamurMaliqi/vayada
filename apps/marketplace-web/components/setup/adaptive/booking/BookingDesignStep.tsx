"use client";

import { CheckIcon, EyeIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
  BOOKING_DESIGN_DEFAULT_FONT_PAIRING,
  BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
  BOOKING_DESIGN_FONT_PAIRINGS,
  BOOKING_DESIGN_PRIMARY_COLORS,
  createBookingDesignButtonColors,
  type BookingDesignFontPairing,
  type BookingDesignPrimaryColor,
  type BookingDesignReadinessResult,
  type BookingDesignRendererSnapshot,
  type BookingDesignRevision,
} from "@vayada/domain-booking";
import { useCallback, useEffect, useRef, useState } from "react";

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
  adaptiveStepResetRequest,
  draftRequest,
  exactSourceRevision,
  isAdaptiveRevisionConflict,
  withDraftReceipt,
} from "../adaptiveSetupStepState";
import { Modal } from "@/components/ui/Modal";
import { adaptiveSetupDraftClient } from "@/services/api/adaptiveSetupDraftClient";
import { bookingDesignClient } from "@/services/api/bookingDesignClient";
import {
  PropertySetupDraftResetError,
  propertySetupDraftResetApi,
} from "@/services/api/propertySetupDraftResetClient";

type BookingDesignForm = {
  primaryColor: BookingDesignPrimaryColor;
  fontPairing: BookingDesignFontPairing;
};

const COLOR_LABELS: Record<BookingDesignPrimaryColor, string> = {
  "#4F46E5": "vayada indigo",
  "#0077B6": "Ocean blue",
  "#2D6A4F": "Forest green",
  "#7B2D8E": "Royal purple",
  "#2D3436": "Charcoal",
};
const FONT_LABELS: Record<BookingDesignFontPairing, string> = {
  "high-end-serif": "High-end Serif",
  "modern-minimalist": "Modern Minimalist",
  "grand-classic": "Grand Classic",
  "imperial-serif": "Imperial Serif",
  "italiana-serif": "Italiana Serif",
};
const BOOKING_PREVIEW_FONT_STYLESHEET =
  "https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Inter:wght@300;400;500;600;700&family=Italiana&family=Lora:ital,wght@0,400;0,700;1,400&family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Sans+Pro:wght@300;400;600;700&display=swap";
const DRAFT_FIELDS = ["booking.primary_color", "booking.font_pairing"] as const;
type BookingDesignField = (typeof DRAFT_FIELDS)[number];

export function BookingDesignStep(props: AdaptiveSetupStepComponentProps) {
  const {
    propertyId,
    route,
    step,
    registerBeforeLeave,
    registerStaleRecovery,
    refreshRoute,
    saveAndContinue,
    reportRevisionConflict,
  } = props;
  const [form, setForm] = useState<BookingDesignForm | null>(null);
  const formRef = useRef<BookingDesignForm | null>(null);
  const designRef = useRef<BookingDesignRevision | null>(null);
  const readinessRef = useRef<BookingDesignReadinessResult | null>(null);
  const savedThisSessionRef = useRef<BookingDesignRevision | null>(null);
  const revisionRef = useRef(adaptiveStepDraftRevision(route, step, "booking_design"));
  const dirtyRef = useRef(false);
  const dirtyFieldsRef = useRef<Set<BookingDesignField>>(new Set());
  const mutationVersionRef = useRef(0);
  const draftSaveRef = useRef<Promise<void> | null>(null);
  const preserveLocalOnReloadRef = useRef(false);
  const [snapshot, setSnapshot] = useState<BookingDesignRendererSnapshot | null>(null);
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const id = "adaptive-booking-preview-fonts";
    const existing = document.getElementById(id);
    if (existing) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = BOOKING_PREVIEW_FONT_STYLESHEET;
    document.head.appendChild(link);
    return () => link.remove();
  }, []);

  useEffect(() => {
    const next = adaptiveStepDraftRevision(route, step, "booking_design");
    if (next.baseRevisions || next.draftRevision > revisionRef.current.draftRevision)
      revisionRef.current = next;
  }, [route, step]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const [design, readiness] = await Promise.all([
          bookingDesignClient.load(propertyId, { signal, cache: "no-store" }),
          bookingDesignClient.loadReadiness(route.scope, { signal, cache: "no-store" }),
        ]);
        if (signal?.aborted) return;
        if (
          readiness.outcome === "ready" &&
          (!design || readiness.designSource.revision !== `design:${design.revision}`)
        ) {
          throw new Error("The private Booking preview did not match the saved design.");
        }
        designRef.current = design;
        readinessRef.current = readiness;
        savedThisSessionRef.current = null;
        if (preserveLocalOnReloadRef.current && formRef.current) {
          const next = mergeLocalDesign(design, formRef.current, dirtyFieldsRef.current);
          formRef.current = next;
          setForm(next);
        } else {
          const next = hydrate(design, step.draft);
          formRef.current = next;
          setForm(next);
          dirtyFieldsRef.current = new Set(
            step.draft?.stepId === "booking_design"
              ? (step.draft.dirtyFields as BookingDesignField[])
              : [],
          );
          dirtyRef.current = false;
          mutationVersionRef.current = 0;
        }
        preserveLocalOnReloadRef.current = false;
        setSnapshot(readiness.outcome === "ready" ? readiness.snapshot : null);
        setPreviewMessage(readinessMessage(readiness));
        if (
          readiness.outcome === "ready" &&
          !snapshotMatchesManifest(readiness.snapshot, revisionRef.current.baseRevisions)
        ) {
          reportRevisionConflict(
            "This design draft is based on older hotel content. Refresh before continuing.",
          );
        }
      } catch (error) {
        if (!signal?.aborted) setLoadError(adaptiveStepErrorMessage(error));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    // Explicit reload only; route refreshes must not overwrite local choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [propertyId, reportRevisionConflict],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reload]);

  const update = useCallback((change: Partial<BookingDesignForm>, field: BookingDesignField) => {
    const current = formRef.current;
    if (!current) return;
    dirtyFieldsRef.current.add(field);
    const next = { ...current, ...change };
    formRef.current = next;
    mutationVersionRef.current += 1;
    dirtyRef.current = true;
    savedThisSessionRef.current = null;
    setForm(next);
  }, []);

  const persistDraft = useCallback(async () => {
    if (draftSaveRef.current) return draftSaveRef.current;
    const pending = (async () => {
      while (dirtyRef.current) {
        const current = formRef.current;
        if (!current) return;
        const mutationVersion = mutationVersionRef.current;
        const receipt = await adaptiveSetupDraftClient.save(
          propertyId,
          draftRequest(revisionRef.current, {
            stepId: "booking_design",
            payload: {
              "booking.primary_color": current.primaryColor,
              "booking.font_pairing": current.fontPairing,
            },
            dirtyFields: Array.from(dirtyFieldsRef.current),
          }),
        );
        revisionRef.current = withDraftReceipt(revisionRef.current, receipt);
        if (mutationVersionRef.current === mutationVersion) dirtyRef.current = false;
      }
      setSaveError(null);
    })();
    draftSaveRef.current = pending;
    try {
      await pending;
    } finally {
      if (draftSaveRef.current === pending) draftSaveRef.current = null;
    }
  }, [propertyId]);

  useEffect(
    () =>
      registerBeforeLeave(async () => {
        setSaveError(null);
        await persistDraft();
        await refreshRoute();
      }),
    [persistDraft, refreshRoute, registerBeforeLeave],
  );

  const recoverStaleDraft = useCallback(async () => {
    const request = adaptiveStepResetRequest(route, step, "booking_design");
    if (!request) {
      preserveLocalOnReloadRef.current = true;
      await refreshRoute();
      setReload((value) => value + 1);
      return;
    }
    try {
      await propertySetupDraftResetApi.reset(propertyId, request);
      dirtyRef.current = true;
      preserveLocalOnReloadRef.current = true;
      await refreshRoute();
      setReload((value) => value + 1);
    } catch (error) {
      if (error instanceof PropertySetupDraftResetError && error.requiresRefresh) {
        preserveLocalOnReloadRef.current = true;
        await refreshRoute();
        setReload((value) => value + 1);
        reportRevisionConflict(error.message);
      }
      throw error;
    }
  }, [propertyId, refreshRoute, reportRevisionConflict, route, step]);

  useEffect(
    () => registerStaleRecovery?.(recoverStaleDraft, step.draft ? "reset" : "refresh"),
    [recoverStaleDraft, registerStaleRecovery, step.draft],
  );

  const submit = async () => {
    if (!formRef.current) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Valid defaults are a deliberate first-visit answer.
      for (const field of DRAFT_FIELDS) dirtyFieldsRef.current.add(field);
      mutationVersionRef.current += 1;
      dirtyRef.current = true;
      await persistDraft();
      const current = formRef.current;
      if (!current) return;
      const source = revisionRef.current.baseRevisions?.["booking.design"];
      const expectedRevision = source ? exactSourceRevision(source, "design") : null;
      const baseRevisions = revisionRef.current.baseRevisions;
      const priorReadiness = readinessRef.current;
      if (
        expectedRevision === null ||
        !baseRevisions ||
        (priorReadiness?.outcome === "ready" &&
          !snapshotMatchesManifest(priorReadiness.snapshot, baseRevisions))
      ) {
        throw new RevisionMismatchError();
      }
      let saved = savedThisSessionRef.current;
      if (!saved || !sameChoices(saved.choices, current)) {
        if (source !== `design:${designRef.current?.revision ?? 0}`) {
          throw new RevisionMismatchError();
        }
        saved = await bookingDesignClient.save(propertyId, {
          expectedRevision,
          choices: current,
        });
        savedThisSessionRef.current = saved;
      }
      designRef.current = saved;
      const readiness = await bookingDesignClient.loadReadiness(route.scope, { cache: "no-store" });
      readinessRef.current = readiness;
      setPreviewMessage(readinessMessage(readiness));
      if (readiness.outcome !== "ready") {
        setSnapshot(null);
        throw new Error("The private Booking preview is not ready yet. Retry in a moment.");
      }
      const expectedManifest = {
        ...baseRevisions,
        "booking.design": `design:${saved.revision}`,
      };
      if (
        !sameChoices(readiness.snapshot.appearance, current) ||
        !snapshotMatchesManifest(readiness.snapshot, expectedManifest)
      ) {
        throw new RevisionMismatchError();
      }
      setSnapshot(readiness.snapshot);
      await saveAndContinue();
    } catch (error) {
      if (error instanceof RevisionMismatchError || isAdaptiveRevisionConflict(error))
        reportRevisionConflict();
      else setSaveError(adaptiveStepErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <AdaptiveStepSkeleton columns />;
  if (loadError || !form) {
    return (
      <div className="mx-auto max-w-6xl">
        <AdaptiveSaveError
          message={loadError ?? "Booking design could not be loaded."}
          onRetry={() => setReload((value) => value + 1)}
        />
      </div>
    );
  }

  return (
    <form
      className="mx-auto max-w-6xl"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {saveError && <AdaptiveSaveError message={saveError} onRetry={() => void submit()} />}
      <div className="grid items-stretch gap-6 lg:grid-cols-[23rem_1fr]">
        <AdaptiveStepCard>
          <fieldset>
            <legend className="text-sm font-semibold text-gray-900">Brand color</legend>
            <p className="mt-1 text-sm text-gray-500">
              Choose a curated, contrast-safe color for primary actions.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              {BOOKING_DESIGN_PRIMARY_COLORS.map((color) => {
                const checked = form.primaryColor === color;
                return (
                  <label
                    key={color}
                    className="relative cursor-pointer rounded-full outline-none focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2"
                    title={COLOR_LABELS[color]}
                  >
                    <input
                      type="radio"
                      name="booking-color"
                      value={color}
                      checked={checked}
                      onChange={() => update({ primaryColor: color }, "booking.primary_color")}
                      className="sr-only"
                      aria-label={COLOR_LABELS[color]}
                    />
                    <span
                      className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-white shadow ring-1 ring-gray-300"
                      style={{ backgroundColor: color }}
                    >
                      {checked && (
                        <CheckIcon className="h-5 w-5 text-white drop-shadow" aria-hidden="true" />
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="mt-3 text-sm font-medium text-gray-700">
              {COLOR_LABELS[form.primaryColor]}
            </p>
          </fieldset>

          <fieldset className="mt-8 border-t border-gray-100 pt-7">
            <legend className="text-sm font-semibold text-gray-900">Typography style</legend>
            <div className="mt-3 space-y-2">
              {(Object.keys(BOOKING_DESIGN_FONT_PAIRINGS) as BookingDesignFontPairing[]).map(
                (fontPairing) => {
                  const checked = form.fontPairing === fontPairing;
                  return (
                    <label
                      key={fontPairing}
                      className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 ${checked ? "border-primary-500 bg-primary-50" : "border-gray-200 hover:bg-gray-50"}`}
                    >
                      <input
                        type="radio"
                        name="booking-font"
                        value={fontPairing}
                        checked={checked}
                        onChange={() => update({ fontPairing }, "booking.font_pairing")}
                        className="h-4 w-4 border-gray-300 text-primary-600 focus:ring-primary-600"
                      />
                      <span
                        className="text-base text-gray-950"
                        style={{
                          fontFamily: BOOKING_DESIGN_FONT_PAIRINGS[fontPairing].headingFamily,
                        }}
                      >
                        {FONT_LABELS[fontPairing]}
                      </span>
                    </label>
                  );
                },
              )}
            </div>
          </fieldset>

          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className={`${adaptiveSecondaryButtonClass} mt-7 w-full gap-2 lg:hidden`}
          >
            <EyeIcon className="h-5 w-5" aria-hidden="true" /> Preview booking page
          </button>
        </AdaptiveStepCard>

        <div className="hidden lg:block">
          <BookingPreview snapshot={snapshot} choices={form} message={previewMessage} />
        </div>
      </div>

      <div className="mt-5 flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className={`${adaptivePrimaryButtonClass} w-full sm:w-auto`}
        >
          {saving ? "Saving…" : "Save and continue"}
        </button>
      </div>

      <Modal
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        size="full"
        className="h-[100dvh] max-h-[100dvh] rounded-none sm:h-auto sm:max-h-[95vh] sm:rounded-xl"
        ariaLabelledBy="booking-preview-dialog-title"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 id="booking-preview-dialog-title" className="font-semibold text-gray-950">
            Booking page preview
          </h2>
          <button
            type="button"
            onClick={() => setPreviewOpen(false)}
            className="rounded-lg p-2 text-gray-600 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-primary-600"
            aria-label="Close booking page preview"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 sm:p-6">
          <BookingPreview snapshot={snapshot} choices={form} message={previewMessage} />
        </div>
      </Modal>
    </form>
  );
}

function BookingPreview({
  snapshot,
  choices,
  message,
}: {
  snapshot: BookingDesignRendererSnapshot | null;
  choices: BookingDesignForm;
  message: string | null;
}) {
  const pairing = BOOKING_DESIGN_FONT_PAIRINGS[choices.fontPairing];
  const button = createBookingDesignButtonColors(choices.primaryColor);
  if (!snapshot) {
    return (
      <section
        aria-label="Booking page preview"
        className="flex min-h-80 items-center justify-center rounded-2xl border border-gray-200 bg-white p-8 text-center"
      >
        <div>
          <EyeIcon className="mx-auto h-8 w-8 text-gray-400" aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold text-gray-900">Private preview unavailable</p>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-gray-600">
            {message ?? "The preview is waiting for verified canonical hotel content."}
          </p>
        </div>
      </section>
    );
  }
  const coverUrl =
    snapshot.cover.kind === "safe_media"
      ? (
          snapshot.cover.publicVariants.find(({ variantName }) => variantName === "large") ??
          snapshot.cover.publicVariants.find(
            ({ variantName }) => variantName === "original_safe",
          ) ??
          snapshot.cover.publicVariants[0]
        )?.publicUrl
      : snapshot.cover.path;
  return (
    <section
      aria-label="Booking page preview"
      className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm"
      style={{ fontFamily: pairing.bodyFamily }}
    >
      <div className="relative flex min-h-80 items-end overflow-hidden bg-gray-900 p-6 sm:min-h-[28rem] sm:p-10">
        {coverUrl && (
          // The typed renderer snapshot already supplies the approved public variant URL.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt={snapshot.cover.kind === "safe_media" ? (snapshot.cover.altText ?? "") : ""}
            className="absolute inset-0 h-full w-full object-cover opacity-70"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-black/10" />
        <div className="relative max-w-xl text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/80">
            Book direct
          </p>
          <h3
            className="mt-3 text-3xl leading-tight sm:text-5xl"
            style={{ fontFamily: pairing.headingFamily }}
          >
            {snapshot.profile.displayName}
          </h3>
          <p className="mt-4 max-w-lg text-sm leading-6 text-white/90 sm:text-base">
            {snapshot.profile.shortDescription}
          </p>
          <span
            className="mt-6 inline-flex min-h-11 items-center rounded-full px-5 py-2.5 text-sm font-semibold"
            style={{
              backgroundColor: button.backgroundColor,
              color: button.foregroundColor,
            }}
            aria-hidden="true"
          >
            Check availability
          </span>
        </div>
      </div>
    </section>
  );
}

function hydrate(
  design: BookingDesignRevision | null,
  routeDraft: AdaptiveSetupStepComponentProps["step"]["draft"],
): BookingDesignForm {
  const form: BookingDesignForm = {
    primaryColor: design?.choices.primaryColor ?? BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
    fontPairing: design?.choices.fontPairing ?? BOOKING_DESIGN_DEFAULT_FONT_PAIRING,
  };
  const draft = routeDraft?.stepId === "booking_design" ? routeDraft : null;
  if (!draft) return form;
  if (
    draft.dirtyFields.includes("booking.primary_color") &&
    BOOKING_DESIGN_PRIMARY_COLORS.includes(
      draft.payload["booking.primary_color"] as BookingDesignPrimaryColor,
    )
  )
    form.primaryColor = draft.payload["booking.primary_color"] as BookingDesignPrimaryColor;
  if (
    draft.dirtyFields.includes("booking.font_pairing") &&
    Object.hasOwn(
      BOOKING_DESIGN_FONT_PAIRINGS,
      draft.payload["booking.font_pairing"] as PropertyKey,
    )
  )
    form.fontPairing = draft.payload["booking.font_pairing"] as BookingDesignFontPairing;
  return form;
}
function mergeLocalDesign(
  design: BookingDesignRevision | null,
  local: BookingDesignForm,
  dirty: ReadonlySet<BookingDesignField>,
): BookingDesignForm {
  const fresh = hydrate(design, null);
  return {
    primaryColor: dirty.has("booking.primary_color") ? local.primaryColor : fresh.primaryColor,
    fontPairing: dirty.has("booking.font_pairing") ? local.fontPairing : fresh.fontPairing,
  };
}
class RevisionMismatchError extends Error {}

function readinessMessage(readiness: BookingDesignReadinessResult): string | null {
  if (readiness.outcome === "ready") return null;
  if (readiness.outcome === "provider_failure") {
    return "The private preview is temporarily unavailable. Retry this step.";
  }
  return readiness.blocker.evidencePort === "design"
    ? "Save these choices to prepare the private preview."
    : "The private preview is waiting for verified hotel content.";
}

function snapshotMatchesManifest(
  snapshot: BookingDesignRendererSnapshot,
  manifest: Readonly<Record<string, string>> | null,
): boolean {
  if (!manifest) return false;
  const sources = new Map(
    snapshot.sourceBindings.map((source) => [
      `${source.ownerDomain}:${source.entityType}`,
      source.revision,
    ]),
  );
  return (
    sources.get("booking:design_revision") === manifest["booking.design"] &&
    sources.get("hotel_catalog:property_profile") === manifest["hotel_catalog.profile"] &&
    sources.get("hotel_catalog:property_media_assignment") === manifest["hotel_catalog.media"]
  );
}

function sameChoices(
  left: Readonly<{ primaryColor: string; fontPairing: string }>,
  right: BookingDesignForm,
): boolean {
  return left.primaryColor === right.primaryColor && left.fontPairing === right.fontPairing;
}
