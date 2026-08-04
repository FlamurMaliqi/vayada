"use client";

import {
  ChevronDownIcon,
  ExclamationTriangleIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";

import type { AdaptiveSetupStepRenderContext } from "../AdaptiveHotelSetupController";
import {
  PRICING_WEEKDAYS,
  PRICING_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE,
  buildPricingDraftRequest,
  discountedDecimal,
  formatDecimal,
  hydratePricingDraft,
  normalizeMoneyInput,
  pricingDraftManifestIsCurrent,
  pricingDraftRevisionContext,
  validatePricingDraft,
  type PricingCanonicalWorkspace,
  type PricingDraftRevisionContext,
  type PricingDraftState,
  type PricingSeasonDraft,
  type PricingValidationErrors,
} from "./pricingState";
import { PricingOwnerError, pricingSetupApi } from "@/services/api/pricingSetupClient";

/** Structural match for the VAY-1116 dispatcher contract without importing its owned file. */
export type AdaptiveSetupStepComponentProps = AdaptiveSetupStepRenderContext & {
  propertyId: string;
  registerBeforeLeave: (callback: () => Promise<void>) => () => void;
};

type WorkspaceState = "loading" | "ready" | "error";

export function PricingStep({
  route,
  step,
  interfaceLocale,
  propertyId,
  saveAndContinue,
  refreshRoute,
  reportRevisionConflict,
  registerBeforeLeave,
}: AdaptiveSetupStepComponentProps) {
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>("loading");
  const [workspace, setWorkspace] = useState<PricingCanonicalWorkspace | null>(null);
  const [draft, setDraft] = useState<PricingDraftState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<PricingValidationErrors>({});
  const [moreOpen, setMoreOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [pendingCurrency, setPendingCurrency] = useState<string | null>(null);
  const draftRef = useRef<PricingDraftState | null>(null);
  const revisionRef = useRef<PricingDraftRevisionContext>(pricingDraftRevisionContext(route, step));
  const routeIdentity = `${route.scope.organizationId}:${route.scope.propertyId}:${route.sessionId ?? "new"}:${step.stepId}`;
  const revisionIdentityRef = useRef(routeIdentity);
  const draftSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const retainLocalOnReloadRef = useRef(false);
  const mounted = useRef(true);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const locale = interfaceLocale;
  const routeRevision = useMemo(() => pricingDraftRevisionContext(route, step), [route, step]);
  const manifestMissing =
    routeRevision.sessionId === null ||
    routeRevision.sessionRevision === null ||
    routeRevision.baseRevisions === null;
  const manifestStale = !pricingDraftManifestIsCurrent(step);
  const propertyMismatch = propertyId.toLowerCase() !== route.scope.propertyId;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const current = revisionRef.current;
    const identityChanged = revisionIdentityRef.current !== routeIdentity;
    const sessionRevisionNewer =
      routeRevision.sessionRevision !== null &&
      (current.sessionRevision === null || routeRevision.sessionRevision > current.sessionRevision);
    const draftRevisionNewer = routeRevision.draftRevision > current.draftRevision;
    if (identityChanged || sessionRevisionNewer || draftRevisionNewer) {
      revisionIdentityRef.current = routeIdentity;
      revisionRef.current = routeRevision;
    }
  }, [routeIdentity, routeRevision]);

  useEffect(() => {
    const controller = new AbortController();
    if (propertyMismatch || step.stepId !== "pricing") {
      setWorkspaceState("error");
      setLoadError("This pricing step does not match the selected hotel.");
      return () => controller.abort();
    }
    setWorkspaceState("loading");
    setLoadError(null);
    void pricingSetupApi
      .loadWorkspace(route.scope.organizationId, propertyId, {
        cache: "no-store",
        signal: controller.signal,
      })
      .then((nextWorkspace) => {
        if (controller.signal.aborted) return;
        const hydrated = hydratePricingDraft(step.draft, nextWorkspace);
        const nextDraft =
          draftRef.current?.dirty || (retainLocalOnReloadRef.current && draftRef.current)
            ? mergeLocalInput(draftRef.current, hydrated)
            : hydrated;
        retainLocalOnReloadRef.current = false;
        draftRef.current = nextDraft;
        setWorkspace(nextWorkspace);
        setDraft(nextDraft);
        setPendingCurrency(
          nextWorkspace.pricing &&
            nextDraft.currencyInput !== "" &&
            nextDraft.currencyInput !== nextWorkspace.pricing.pricingCurrency.currency
            ? nextDraft.currencyInput
            : null,
        );
        if (
          nextDraft.seasons.length > 0 ||
          nextDraft.weekendEnabled ||
          nextDraft.rooms.some(({ additionalGuestEnabled }) => additionalGuestEnabled)
        ) {
          setMoreOpen(true);
        }
        setWorkspaceState("ready");
        setSaveError(null);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setWorkspaceState("error");
        setLoadError(errorMessage(error));
      });
    return () => controller.abort();
  }, [propertyId, propertyMismatch, reload, route.scope.organizationId, step.draft, step.stepId]);

  const commit = useCallback((next: PricingDraftState) => {
    draftRef.current = next;
    if (mounted.current) setDraft(next);
  }, []);

  const change = useCallback(
    (update: (current: PricingDraftState) => PricingDraftState) => {
      const current = draftRef.current;
      if (!current) return;
      commit({
        ...update(current),
        mandatoryChargesAcknowledged: false,
        dirty: true,
      });
      setNotice(null);
    },
    [commit],
  );

  const persistDraft = useCallback(() => {
    const run = async () => {
      const current = draftRef.current;
      if (!current?.dirty) return;
      const request = buildPricingDraftRequest(current, revisionRef.current, locale);
      try {
        const receipt = await pricingSetupApi.saveDraft(propertyId, request);
        revisionRef.current = {
          ...revisionRef.current,
          sessionId: receipt.sessionId,
          trackRevision: receipt.trackRevision,
          sessionRevision: receipt.sessionRevision,
          draftRevision: receipt.draftRevision,
        };
        if (draftRef.current === current) commit({ ...current, dirty: false });
        setSaveError(null);
      } catch (error) {
        if (error instanceof PricingOwnerError && error.requiresRefresh) {
          reportRevisionConflict(error.message);
        }
        setSaveError(errorMessage(error));
        throw error;
      }
    };
    const next = draftSaveChainRef.current.catch(() => undefined).then(run);
    draftSaveChainRef.current = next;
    return next;
  }, [commit, locale, propertyId, reportRevisionConflict]);

  useEffect(() => registerBeforeLeave(persistDraft), [persistDraft, registerBeforeLeave]);

  const save = useCallback(async () => {
    const current = draftRef.current;
    if (!current || !workspace || saving) return;
    const nextErrors = validatePricingDraft(current, locale);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      if (hasOptionalErrors(nextErrors)) setMoreOpen(true);
      focusFirstPricingError(nextErrors, errorSummaryRef);
      return;
    }
    if (manifestMissing) {
      setSaveError(PRICING_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE);
      return;
    }
    if (manifestStale) {
      setSaveError(
        "Pricing changed since this draft was started. Reload the latest setup before applying canonical prices.",
      );
      return;
    }
    if (
      pendingCurrency ||
      !workspace.currencyCapabilities.supportedCurrencies.some(
        ({ code }) => code === current.currencyInput,
      )
    ) {
      setSaveError("Choose and confirm a supported pricing currency before continuing.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      await persistDraft();
      if (draftRef.current?.dirty) {
        setNotice("Newer edits are still in your draft. Save again when you are ready.");
        return;
      }
      const canonicalInput = draftRef.current;
      if (!canonicalInput) return;
      const saved = await pricingSetupApi.saveCanonical(
        route.scope.organizationId,
        propertyId,
        canonicalInput,
        workspace,
        locale,
      );
      if (!mounted.current) return;
      const hydrated = hydratePricingDraft(null, saved);
      setWorkspace(saved);
      const latest = draftRef.current;
      if (latest !== canonicalInput) {
        if (!latest) return;
        const retained = mergeLocalInput(latest, hydrated);
        commit({ ...retained, dirty: true });
        setNotice(
          "Prices were saved. Your latest edits remain in the draft and still need saving.",
        );
        return;
      }
      commit(hydrated);
      setNotice("Prices and final-price confirmation saved.");
      await refreshRoute();
      await saveAndContinue();
    } catch (error) {
      if (error instanceof PricingOwnerError && error.requiresRefresh) {
        reportRevisionConflict(error.message);
      }
      retainLocalOnReloadRef.current = true;
      if (mounted.current) setSaveError(errorMessage(error));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [
    locale,
    manifestMissing,
    manifestStale,
    pendingCurrency,
    persistDraft,
    propertyId,
    refreshRoute,
    reportRevisionConflict,
    route.scope.organizationId,
    saveAndContinue,
    saving,
    workspace,
  ]);

  const saveDraftOnly = useCallback(async () => {
    if (saving || !draftRef.current?.dirty) return;
    if (manifestMissing) {
      setSaveError(PRICING_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      await persistDraft();
      if (mounted.current) {
        setNotice(
          draftRef.current?.dirty
            ? "Earlier changes were saved. Your latest edits still need saving."
            : "Pricing draft saved.",
        );
      }
    } catch {
      // persistDraft reports the actionable owner error and before-leave callers still reject.
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [manifestMissing, persistDraft, saving]);

  const reloadLatest = useCallback(async () => {
    retainLocalOnReloadRef.current = true;
    try {
      await refreshRoute();
      if (mounted.current) setReload((value) => value + 1);
    } catch (error) {
      if (mounted.current) setSaveError(errorMessage(error));
    }
  }, [refreshRoute]);

  if (workspaceState === "loading") return <PricingSkeleton />;
  if (workspaceState === "error" || !draft || !workspace) {
    return (
      <RecoveryPanel
        title="Pricing could not be loaded"
        message={loadError ?? "Refresh the pricing workspace and try again."}
        actionLabel="Retry"
        onAction={() => setReload((value) => value + 1)}
      />
    );
  }

  const canonicalCurrency = workspace.pricing?.pricingCurrency.currency ?? null;
  const currency = draft.currencyInput || canonicalCurrency;
  const supportedCurrencies = workspace.currencyCapabilities.supportedCurrencies;
  const currencyUnavailable =
    pendingCurrency !== null ||
    currency === null ||
    !supportedCurrencies.some(({ code }) => code === currency);
  const chooseCurrency = (nextCurrency: string) => {
    if (canonicalCurrency && nextCurrency !== canonicalCurrency) {
      setPendingCurrency(nextCurrency);
      return;
    }
    setPendingCurrency(null);
    change((current) => ({ ...current, currencyInput: nextCurrency }));
    setErrors({});
  };
  const confirmCurrencyChange = () => {
    if (!pendingCurrency) return;
    const nextCurrency = pendingCurrency;
    change((current) => clearMonetaryInputs({ ...current, currencyInput: nextCurrency }));
    setPendingCurrency(null);
    setErrors({});
    setNotice(
      `Currency changed to ${nextCurrency}. Enter every monetary amount again; values were not converted.`,
    );
  };
  const eligibleAdditionalRooms = draft.rooms.filter(
    ({ maximumAdults, additionalGuestEnabled }) => maximumAdults > 1 || additionalGuestEnabled,
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-10">
      {manifestMissing && (
        <RecoveryPanel
          title="Setup data is still unavailable"
          message="Your input stays on this page, but saving is blocked until the server supplies the exact pricing revision manifest."
          actionLabel="Refresh setup"
          onAction={() => void refreshRoute()}
        />
      )}

      {manifestStale && (
        <RecoveryPanel
          title="Pricing changed since this draft was started"
          message="The saved draft keeps its historical revision manifest and cannot overwrite newer pricing. Reload setup to review the latest owner state."
          actionLabel="Reload latest"
          onAction={() => void reloadLatest()}
        />
      )}

      {pendingCurrency && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-4" role="alert">
          <div className="flex gap-3">
            <ExclamationTriangleIcon
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-700"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-sm font-semibold text-amber-950">
                Change currency and clear every amount?
              </h2>
              <p className="mt-1 text-sm leading-6 text-amber-900">
                Prices cannot be converted safely. Changing from {canonicalCurrency} to{" "}
                {pendingCurrency}
                clears base, seasonal, weekend, and additional-guest amounts.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="min-h-11 rounded-full bg-amber-900 px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-amber-900 focus-visible:ring-offset-2"
                  onClick={confirmCurrencyChange}
                >
                  Change and clear prices
                </button>
                <button
                  type="button"
                  className="min-h-11 rounded-full border border-amber-500 bg-white px-4 text-sm font-semibold text-amber-950 outline-none focus-visible:ring-2 focus-visible:ring-amber-900 focus-visible:ring-offset-2"
                  onClick={() => chooseCurrency(canonicalCurrency!)}
                >
                  Keep {canonicalCurrency}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {saveError && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-4" role="alert">
          <p className="text-sm font-semibold text-red-950">Pricing was not saved</p>
          <p className="mt-1 text-sm leading-6 text-red-900">{saveError}</p>
          <button
            type="button"
            onClick={() => void reloadLatest()}
            className="mt-3 min-h-11 rounded-full border border-red-400 bg-white px-4 text-sm font-semibold text-red-900 outline-none hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2"
          >
            Reload latest
          </button>
        </div>
      )}

      {notice && (
        <p
          className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-950"
          role="status"
        >
          {notice}
        </p>
      )}

      {Object.keys(errors).length > 0 && (
        <div
          ref={errorSummaryRef}
          tabIndex={-1}
          className="rounded-xl border border-red-300 bg-red-50 px-5 py-4 outline-none focus-visible:ring-2 focus-visible:ring-red-700"
          role="alert"
        >
          <h2 className="text-sm font-semibold text-red-950">Check the pricing details</h2>
          <p className="mt-1 text-sm text-red-900">
            Complete every enabled price before continuing.
          </p>
        </div>
      )}

      <section aria-labelledby="pricing-currency-heading">
        <SectionHeading
          id="pricing-currency-heading"
          title="Currency"
          description="Use one currency for every room and payment method."
        />
        <div className="mt-4 max-w-sm">
          <label htmlFor="pricing-currency" className="block text-sm font-semibold text-gray-900">
            Hotel pricing currency
          </label>
          <select
            id="pricing-currency"
            value={pendingCurrency ?? draft.currencyInput}
            onChange={(event) => chooseCurrency(event.target.value)}
            aria-invalid={Boolean(errors.currency)}
            aria-describedby={errors.currency ? "pricing-currency-error" : undefined}
            className={inputClass(Boolean(errors.currency))}
          >
            <option value="" disabled>
              Choose currency
            </option>
            {supportedCurrencies.map(({ code }) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
          <FieldError id="pricing-currency-error">{errors.currency}</FieldError>
        </div>
      </section>

      <section className="border-t border-gray-200 pt-8" aria-labelledby="standard-prices-heading">
        <SectionHeading
          id="standard-prices-heading"
          title="Standard nightly prices"
          description="The base price applies whenever no optional seasonal price applies."
        />
        {draft.rooms.length === 0 ? (
          <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            Complete at least one room before setting prices.
          </p>
        ) : (
          <div className="mt-5 space-y-4">
            {draft.rooms.map((room) => (
              <div
                key={room.roomTypeId}
                className="grid gap-4 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)] sm:items-end"
              >
                <div>
                  <h3 className="font-semibold text-gray-950">{room.name}</h3>
                  <p className="mt-1 text-sm text-gray-600">Up to {room.maximumAdults} adults</p>
                  <p className="mt-2 text-xs font-medium text-primary-700">
                    Flexible rate included
                  </p>
                </div>
                <MoneyField
                  id={`base-${room.roomTypeId}`}
                  label="Nightly price"
                  currency={currency}
                  value={room.baseAmountInput}
                  error={errors[`base.${room.roomTypeId}`]}
                  onChange={(value) =>
                    change((current) => ({
                      ...current,
                      rooms: current.rooms.map((item) =>
                        item.roomTypeId === room.roomTypeId
                          ? { ...item, baseAmountInput: value }
                          : item,
                      ),
                    }))
                  }
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="border-t border-gray-200 pt-8" aria-labelledby="cancellation-heading">
        <SectionHeading
          id="cancellation-heading"
          title="Cancellation"
          description="Every room includes a flexible rate. The full booking amount is non-refundable after the deadline and for no-shows."
        />
        <div className="mt-5 max-w-lg">
          <label
            htmlFor="free-cancellation-days"
            className="block text-sm font-semibold text-gray-900"
          >
            Free cancellation until
          </label>
          <div className="mt-2 flex items-center gap-3">
            <input
              id="free-cancellation-days"
              inputMode="numeric"
              value={draft.freeCancellationDeadlineDaysInput}
              onChange={(event) =>
                change((current) => ({
                  ...current,
                  freeCancellationDeadlineDaysInput: event.target.value,
                }))
              }
              aria-invalid={Boolean(errors.cancellation)}
              aria-describedby={errors.cancellation ? "free-cancellation-days-error" : undefined}
              className={inputClass(Boolean(errors.cancellation), "w-24")}
            />
            <span className="text-sm text-gray-700">days before arrival</span>
          </div>
          <FieldError id="free-cancellation-days-error">{errors.cancellation}</FieldError>
          <p className="mt-2 text-sm leading-6 text-gray-600">
            Enter 0 for free cancellation until the hotel check-in time on arrival day.
          </p>
        </div>

        <label className="mt-6 flex min-h-11 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={draft.nonRefundableEnabled}
            onChange={(event) =>
              change((current) => ({ ...current, nonRefundableEnabled: event.target.checked }))
            }
            className="mt-1 h-5 w-5 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
          />
          <span>
            <span className="block text-sm font-semibold text-gray-950">
              Offer a cheaper non-refundable rate
            </span>
            <span className="mt-1 block text-sm leading-6 text-gray-600">
              This offer becomes available after online payments can charge the full booking amount.
            </span>
          </span>
        </label>
        {draft.nonRefundableEnabled && (
          <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <label
              htmlFor="non-refundable-discount"
              className="block text-sm font-semibold text-gray-900"
            >
              Discount from every flexible price
            </label>
            <div className="mt-2 flex items-center gap-2">
              <input
                id="non-refundable-discount"
                inputMode="numeric"
                value={draft.nonRefundableDiscountInput}
                onChange={(event) =>
                  change((current) => ({
                    ...current,
                    nonRefundableDiscountInput: event.target.value,
                  }))
                }
                aria-invalid={Boolean(errors.nonRefundable)}
                aria-describedby={
                  errors.nonRefundable ? "non-refundable-discount-error" : undefined
                }
                className={inputClass(Boolean(errors.nonRefundable), "w-24")}
              />
              <span className="text-sm text-gray-700">%</span>
            </div>
            <FieldError id="non-refundable-discount-error">{errors.nonRefundable}</FieldError>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {draft.rooms.map((room) => (
                <p key={room.roomTypeId} className="text-sm text-gray-700">
                  <span className="font-medium text-gray-950">{room.name}:</span>{" "}
                  {nonRefundablePreview(
                    room.baseAmountInput,
                    draft.nonRefundableDiscountInput,
                    locale,
                    currency,
                  )}
                </p>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="border-t border-gray-200 pt-8" aria-labelledby="more-pricing-heading">
        <button
          type="button"
          aria-expanded={moreOpen}
          aria-controls="more-pricing-options"
          onClick={() => setMoreOpen((value) => !value)}
          className="flex min-h-11 w-full items-center justify-between gap-4 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
        >
          <span>
            <span id="more-pricing-heading" className="block text-lg font-semibold text-gray-950">
              More pricing options
            </span>
            <span className="mt-1 block text-sm text-gray-600">
              Seasonal prices, weekend prices, and additional-guest prices
            </span>
          </span>
          <ChevronDownIcon
            className={`h-5 w-5 shrink-0 text-gray-500 transition-transform ${moreOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
        {moreOpen && (
          <div id="more-pricing-options" className="mt-6 space-y-10">
            <SeasonEditor draft={draft} currency={currency} errors={errors} onChange={change} />
            <WeekendEditor draft={draft} currency={currency} errors={errors} onChange={change} />
            <AdditionalGuestEditor
              rooms={eligibleAdditionalRooms}
              currency={currency}
              errors={errors}
              onChange={change}
            />
          </div>
        )}
      </section>

      <section className="border-t border-gray-200 pt-8">
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-300 bg-white p-4">
          <input
            id="mandatory-charges-acknowledged"
            type="checkbox"
            checked={draft.mandatoryChargesAcknowledged}
            onChange={(event) => {
              const current = draftRef.current;
              if (!current) return;
              const next = {
                ...current,
                mandatoryChargesAcknowledged: event.target.checked,
                dirty: true,
              };
              commit(next);
            }}
            aria-invalid={Boolean(errors.mandatory)}
            aria-describedby="mandatory-charges-help mandatory-charges-error"
            className="mt-1 h-5 w-5 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
          />
          <span>
            <span className="block text-sm font-semibold text-gray-950">
              These are the final prices guests will see, including predictable mandatory charges.
            </span>
            <span
              id="mandatory-charges-help"
              className="mt-1 block text-sm leading-6 text-gray-600"
            >
              The hotel remains responsible for taxes, invoices, and legally required reporting.
              Optional guest-selected add-ons and promotions remain separate.
            </span>
          </span>
        </label>
        <FieldError id="mandatory-charges-error">{errors.mandatory}</FieldError>
      </section>

      <div className="flex flex-col items-stretch gap-3 border-t border-gray-200 pt-6 sm:items-end">
        <button
          type="button"
          disabled={saving || manifestMissing || !draft.dirty}
          onClick={() => void saveDraftOnly()}
          className="min-h-11 whitespace-nowrap rounded-full border border-gray-300 bg-white px-6 text-sm font-semibold text-gray-800 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-gray-400"
        >
          Save draft
        </button>
        <button
          type="button"
          disabled={saving || manifestMissing || manifestStale || currencyUnavailable}
          onClick={() => void save()}
          className="min-h-11 whitespace-nowrap rounded-full bg-primary-600 px-6 text-sm font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-primary-300"
        >
          {saving ? "Saving prices..." : "Save and continue"}
        </button>
      </div>
    </div>
  );
}

function SeasonEditor({
  draft,
  currency,
  errors,
  onChange,
}: {
  draft: PricingDraftState;
  currency: string | null;
  errors: PricingValidationErrors;
  onChange: (update: (current: PricingDraftState) => PricingDraftState) => void;
}) {
  const updateSeason = (
    index: number,
    update: (season: PricingSeasonDraft) => PricingSeasonDraft,
  ) =>
    onChange((current) => ({
      ...current,
      seasons: current.seasons.map((season, position) =>
        position === index ? update(season) : season,
      ),
    }));
  return (
    <div>
      <h3 className="text-base font-semibold text-gray-950">Seasonal prices</h3>
      <p className="mt-1 text-sm leading-6 text-gray-600">
        Add named annual periods. Every season needs an explicit price for each room.
      </p>
      <div className="mt-4 space-y-5">
        {draft.seasons.map((season, index) => (
          <div
            key={season.sourceId}
            className="rounded-xl border border-gray-200 bg-gray-50 p-4 sm:p-5"
          >
            <div className="flex items-start justify-between gap-4">
              <h4 className="font-semibold text-gray-950">{season.name || "New season"}</h4>
              <button
                type="button"
                aria-label={`Remove ${season.name || "season"}`}
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    seasons: current.seasons.filter((_, position) => position !== index),
                  }))
                }
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-gray-600 outline-none hover:bg-gray-200 hover:text-red-700 focus-visible:ring-2 focus-visible:ring-primary-600"
              >
                <TrashIcon className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <TextField
                id={`season-${index}-name`}
                label="Season name"
                value={season.name}
                error={errors[`season.${index}.name`]}
                onChange={(value) =>
                  updateSeason(index, (current) => ({ ...current, name: value }))
                }
              />
              <TextField
                id={`season-${index}-start`}
                label="Start (MM-DD)"
                value={season.startMonthDay}
                error={errors[`season.${index}.start`]}
                onChange={(value) =>
                  updateSeason(index, (current) => ({ ...current, startMonthDay: value }))
                }
              />
              <TextField
                id={`season-${index}-end`}
                label="End (MM-DD)"
                value={season.endMonthDay}
                error={errors[`season.${index}.end`] ?? errors[`season.${index}.dates`]}
                onChange={(value) =>
                  updateSeason(index, (current) => ({ ...current, endMonthDay: value }))
                }
              />
            </div>
            <p className="mt-2 text-xs font-medium text-gray-600">Repeats every year</p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {draft.rooms.map((room) => (
                <MoneyField
                  key={room.roomTypeId}
                  id={`season-${index}-${room.roomTypeId}`}
                  label={`${room.name} nightly price`}
                  currency={currency}
                  value={season.roomPrices[room.roomTypeId] ?? ""}
                  error={errors[`season.${index}.${room.roomTypeId}`]}
                  onChange={(value) =>
                    updateSeason(index, (current) => ({
                      ...current,
                      roomPrices: { ...current.roomPrices, [room.roomTypeId]: value },
                    }))
                  }
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          onChange((current) => ({
            ...current,
            seasons: [
              ...current.seasons,
              {
                sourceId: crypto.randomUUID(),
                sourceRevision: 0,
                name: "",
                startMonthDay: "",
                endMonthDay: "",
                roomPrices: Object.fromEntries(
                  current.rooms.map((room) => [room.roomTypeId, room.baseAmountInput]),
                ),
              },
            ],
          }))
        }
        className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
      >
        <PlusIcon className="h-4 w-4" aria-hidden="true" />
        Add seasonal pricing
      </button>
    </div>
  );
}

function WeekendEditor({
  draft,
  currency,
  errors,
  onChange,
}: {
  draft: PricingDraftState;
  currency: string | null;
  errors: PricingValidationErrors;
  onChange: (update: (current: PricingDraftState) => PricingDraftState) => void;
}) {
  return (
    <div className="border-t border-gray-200 pt-8">
      <label className="flex min-h-11 cursor-pointer items-start gap-3">
        <input
          id="weekend-pricing-enabled"
          type="checkbox"
          checked={draft.weekendEnabled}
          onChange={(event) =>
            onChange((current) => ({ ...current, weekendEnabled: event.target.checked }))
          }
          className="mt-1 h-5 w-5 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
        />
        <span>
          <span className="block text-base font-semibold text-gray-950">Weekend prices</span>
          <span className="mt-1 block text-sm leading-6 text-gray-600">
            Add one fixed amount per room for the selected stay nights.
          </span>
        </span>
      </label>
      {draft.weekendEnabled && (
        <div className="mt-5">
          <fieldset aria-describedby={errors.weekendDays ? "weekend-days-error" : undefined}>
            <legend className="text-sm font-semibold text-gray-900">Weekend nights</legend>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {PRICING_WEEKDAYS.map((day) => (
                <label
                  key={day}
                  className="flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm capitalize text-gray-800"
                >
                  <input
                    id={`weekend-day-${day}`}
                    type="checkbox"
                    checked={draft.weekendDays.includes(day)}
                    onChange={(event) =>
                      onChange((current) => ({
                        ...current,
                        weekendDays: event.target.checked
                          ? PRICING_WEEKDAYS.filter((item) =>
                              [...current.weekendDays, day].includes(item),
                            )
                          : current.weekendDays.filter((item) => item !== day),
                      }))
                    }
                    className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
                  />
                  {day.slice(0, 3)}
                </label>
              ))}
            </div>
            <FieldError id="weekend-days-error">{errors.weekendDays}</FieldError>
          </fieldset>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {draft.rooms.map((room) => (
              <MoneyField
                key={room.roomTypeId}
                id={`weekend-${room.roomTypeId}`}
                label={`${room.name} additional amount`}
                currency={currency}
                value={draft.weekendSurcharges[room.roomTypeId] ?? ""}
                error={errors[`weekend.${room.roomTypeId}`]}
                onChange={(value) =>
                  onChange((current) => ({
                    ...current,
                    weekendSurcharges: { ...current.weekendSurcharges, [room.roomTypeId]: value },
                  }))
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AdditionalGuestEditor({
  rooms,
  currency,
  errors,
  onChange,
}: {
  rooms: PricingDraftState["rooms"];
  currency: string | null;
  errors: PricingValidationErrors;
  onChange: (update: (current: PricingDraftState) => PricingDraftState) => void;
}) {
  return (
    <div className="border-t border-gray-200 pt-8">
      <h3 className="text-base font-semibold text-gray-950">Additional-guest prices</h3>
      <p className="mt-1 text-sm leading-6 text-gray-600">
        Enable a threshold and fixed nightly amount only for rooms that accept more than one adult.
      </p>
      {rooms.length === 0 ? (
        <p className="mt-4 text-sm text-gray-600">No room currently supports this option.</p>
      ) : (
        <div className="mt-5 space-y-4">
          {rooms.map((room) => (
            <div key={room.roomTypeId} className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <label className="flex min-h-11 cursor-pointer items-start gap-3">
                <input
                  id={`additional-guest-enabled-${room.roomTypeId}`}
                  type="checkbox"
                  checked={room.additionalGuestEnabled}
                  onChange={(event) =>
                    onChange((current) => ({
                      ...current,
                      rooms: current.rooms.map((item) =>
                        item.roomTypeId === room.roomTypeId
                          ? { ...item, additionalGuestEnabled: event.target.checked }
                          : item,
                      ),
                    }))
                  }
                  className="mt-1 h-5 w-5 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
                />
                <span className="text-sm font-semibold text-gray-950">{room.name}</span>
              </label>
              {room.additionalGuestEnabled && room.maximumAdults <= 1 && (
                <p
                  className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-950"
                  role="alert"
                >
                  This room now allows only one adult. Turn off this saved rule or update room
                  occupancy before continuing.
                </p>
              )}
              {room.additionalGuestEnabled && (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <TextField
                    id={`included-guests-${room.roomTypeId}`}
                    label="Guests included in the nightly price"
                    value={room.includedGuestsInput}
                    inputMode="numeric"
                    error={errors[`included.${room.roomTypeId}`]}
                    onChange={(value) =>
                      onChange((current) => ({
                        ...current,
                        rooms: current.rooms.map((item) =>
                          item.roomTypeId === room.roomTypeId
                            ? { ...item, includedGuestsInput: value }
                            : item,
                        ),
                      }))
                    }
                  />
                  <MoneyField
                    id={`additional-guest-${room.roomTypeId}`}
                    label="Each additional guest per night"
                    currency={currency}
                    value={room.additionalGuestAmountInput}
                    error={errors[`additional.${room.roomTypeId}`]}
                    onChange={(value) =>
                      onChange((current) => ({
                        ...current,
                        rooms: current.rooms.map((item) =>
                          item.roomTypeId === room.roomTypeId
                            ? { ...item, additionalGuestAmountInput: value }
                            : item,
                        ),
                      }))
                    }
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MoneyField({
  id,
  label,
  currency,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  currency: string | null;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-gray-900">
        {label}
      </label>
      <div className="relative mt-2">
        {currency && (
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm font-medium text-gray-600">
            {currency}
          </span>
        )}
        <input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          className={inputClass(Boolean(error), currency ? "pl-14" : "")}
        />
      </div>
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  error,
  inputMode,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  inputMode?: "numeric";
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-gray-900">
        {label}
      </label>
      <input
        id={id}
        inputMode={inputMode}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`mt-2 ${inputClass(Boolean(error))}`}
      />
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

function SectionHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <h2 id={id} className="text-lg font-semibold text-gray-950">
        {title}
      </h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">{description}</p>
    </div>
  );
}

function FieldError({ id, children }: { id?: string; children?: ReactNode }) {
  return children ? (
    <p id={id} className="mt-2 text-sm font-medium text-red-700">
      {children}
    </p>
  ) : null;
}

function RecoveryPanel({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-5" role="alert">
      <h2 className="text-sm font-semibold text-amber-950">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-amber-900">{message}</p>
      <button
        type="button"
        onClick={onAction}
        className="mt-3 min-h-11 rounded-full border border-amber-500 bg-white px-4 text-sm font-semibold text-amber-950 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2"
      >
        {actionLabel}
      </button>
    </div>
  );
}

function PricingSkeleton() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6" role="status" aria-label="Loading pricing">
      <div className="h-24 animate-pulse rounded-xl bg-gray-200" />
      <div className="h-40 animate-pulse rounded-xl bg-gray-200" />
      <span className="sr-only">Loading pricing...</span>
    </div>
  );
}

function inputClass(error: boolean, extra = ""): string {
  return `min-h-11 w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-950 outline-none placeholder:text-gray-500 focus-visible:ring-2 focus-visible:ring-offset-1 ${
    error
      ? "border-red-500 focus-visible:ring-red-600"
      : "border-gray-300 focus-visible:border-primary-600 focus-visible:ring-primary-600"
  } ${extra}`;
}

function nonRefundablePreview(
  input: string,
  discountInput: string,
  locale: string,
  currency: string | null,
): string {
  const amount = normalizeMoneyInput(input, locale, false);
  const discount = /^\d+$/.test(discountInput) ? Number(discountInput) : null;
  if (!amount || discount === null || discount < 1 || discount > 50)
    return "Complete the price and discount";
  const result = formatDecimal(discountedDecimal(amount, discount), locale);
  return currency ? `${currency} ${result}` : result;
}

function hasOptionalErrors(errors: PricingValidationErrors): boolean {
  return Object.keys(errors).some(
    (key) =>
      key.startsWith("season.") ||
      key.startsWith("weekend") ||
      key.startsWith("included.") ||
      key.startsWith("additional."),
  );
}

function focusFirstPricingError(
  errors: PricingValidationErrors,
  summaryRef: { current: HTMLDivElement | null },
): void {
  const first = Object.keys(errors)[0];
  const targetId = first ? pricingErrorTargetId(first) : null;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const target = targetId ? document.getElementById(targetId) : null;
      if (target && typeof target.focus === "function") target.focus();
      else summaryRef.current?.focus();
    }),
  );
}

function pricingErrorTargetId(key: string): string | null {
  if (key.startsWith("base.")) return `base-${key.slice("base.".length)}`;
  if (key === "cancellation") return "free-cancellation-days";
  if (key === "nonRefundable") return "non-refundable-discount";
  if (key === "weekendDays") return "weekend-day-friday";
  if (key.startsWith("weekend.")) return `weekend-${key.slice("weekend.".length)}`;
  if (key.startsWith("included.")) return `included-guests-${key.slice("included.".length)}`;
  if (key.startsWith("additional.")) return `additional-guest-${key.slice("additional.".length)}`;
  if (key === "mandatory") return "mandatory-charges-acknowledged";
  const season = /^season\.(\d+)\.(name|start|end|dates|.+)$/.exec(key);
  if (!season) return null;
  if (season[2] === "name") return `season-${season[1]}-name`;
  if (season[2] === "start") return `season-${season[1]}-start`;
  if (season[2] === "end" || season[2] === "dates") return `season-${season[1]}-end`;
  return `season-${season[1]}-${season[2]}`;
}

function mergeLocalInput(
  local: PricingDraftState,
  canonical: PricingDraftState,
): PricingDraftState {
  const localRooms = new Map(local.rooms.map((room) => [room.roomTypeId, room]));
  const canonicalSeasons = new Map(canonical.seasons.map((season) => [season.sourceId, season]));
  const roomFactsChanged =
    local.rooms.length !== canonical.rooms.length ||
    canonical.rooms.some((room) => {
      const previous = localRooms.get(room.roomTypeId);
      return (
        !previous ||
        previous.roomFactsRevision !== room.roomFactsRevision ||
        previous.maximumAdults !== room.maximumAdults ||
        previous.name !== room.name
      );
    });
  const pricingEvidenceChanged =
    roomFactsChanged ||
    canonical.rooms.some((room) => {
      const previous = localRooms.get(room.roomTypeId);
      return (
        previous?.flexibleRatePlanRevision !== room.flexibleRatePlanRevision ||
        previous?.additionalGuestSourceRevision !== room.additionalGuestSourceRevision
      );
    }) ||
    local.pricingCurrencyRevision !== canonical.pricingCurrencyRevision ||
    local.weekendSourceRevision !== canonical.weekendSourceRevision ||
    local.nonRefundableSourceRevision !== canonical.nonRefundableSourceRevision ||
    local.seasons.length !== canonical.seasons.length ||
    canonical.seasons.some(
      (season) =>
        local.seasons.find(({ sourceId }) => sourceId === season.sourceId)?.sourceRevision !==
        season.sourceRevision,
    );
  return {
    ...local,
    pricingCurrencyRevision: canonical.pricingCurrencyRevision,
    confirmationRevision: canonical.confirmationRevision,
    mandatoryChargesAcknowledged:
      pricingEvidenceChanged ||
      (canonical.confirmationRevision > 0 && !canonical.mandatoryChargesAcknowledged)
        ? false
        : local.mandatoryChargesAcknowledged,
    rooms: canonical.rooms.map((room) => {
      const previous = localRooms.get(room.roomTypeId);
      if (!previous) return room;
      return {
        ...room,
        baseAmountInput: previous.baseAmountInput,
        additionalGuestEnabled: previous.additionalGuestEnabled,
        includedGuestsInput: previous.includedGuestsInput,
        additionalGuestAmountInput: previous.additionalGuestAmountInput,
        additionalGuestSourceId:
          room.additionalGuestSourceRevision === 0
            ? previous.additionalGuestSourceId
            : room.additionalGuestSourceId,
      };
    }),
    seasons: [
      ...canonical.seasons.map((season) => {
        const previous = local.seasons.find(({ sourceId }) => sourceId === season.sourceId);
        return previous
          ? {
              ...season,
              name: previous.name,
              startMonthDay: previous.startMonthDay,
              endMonthDay: previous.endMonthDay,
              roomPrices: Object.fromEntries(
                canonical.rooms.map((room) => [
                  room.roomTypeId,
                  previous.roomPrices[room.roomTypeId] ??
                    season.roomPrices[room.roomTypeId] ??
                    room.baseAmountInput,
                ]),
              ),
            }
          : season;
      }),
      ...local.seasons.filter(
        (season) => season.sourceRevision === 0 && !canonicalSeasons.has(season.sourceId),
      ),
    ],
    weekendSourceId:
      canonical.weekendSourceRevision === 0 ? local.weekendSourceId : canonical.weekendSourceId,
    weekendSourceRevision: canonical.weekendSourceRevision,
    weekendSurcharges: Object.fromEntries(
      canonical.rooms.map((room) => [
        room.roomTypeId,
        local.weekendSurcharges[room.roomTypeId] ??
          canonical.weekendSurcharges[room.roomTypeId] ??
          "",
      ]),
    ),
    nonRefundableSourceId:
      canonical.nonRefundableSourceRevision === 0
        ? local.nonRefundableSourceId
        : canonical.nonRefundableSourceId,
    nonRefundableSourceRevision: canonical.nonRefundableSourceRevision,
  };
}

function clearMonetaryInputs(state: PricingDraftState): PricingDraftState {
  return {
    ...state,
    rooms: state.rooms.map((room) => ({
      ...room,
      baseAmountInput: "",
      additionalGuestAmountInput: "",
    })),
    seasons: state.seasons.map((season) => ({
      ...season,
      roomPrices: Object.fromEntries(Object.keys(season.roomPrices).map((roomId) => [roomId, ""])),
    })),
    weekendSurcharges: Object.fromEntries(
      Object.keys(state.weekendSurcharges).map((roomId) => [roomId, ""]),
    ),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Pricing could not be saved. Try again.";
}
