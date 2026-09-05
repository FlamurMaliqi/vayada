"use client";

import { useRef, useState } from "react";
import { Button, Textarea } from "@/components/ui";
import { MONTHS_ABBR } from "@/lib/constants";
import { XMarkIcon, CheckIcon } from "@heroicons/react/24/outline";
import { getMonthAbbr } from "@/lib/utils";
import { usePlatformDeliverables } from "@/hooks/usePlatformDeliverables";
import { PlatformDeliverablesSelector } from "./PlatformDeliverablesSelector";
import { DateMonthPicker } from "./DateMonthPicker";
import type { PlatformDeliverable } from "./types";
import type { CollaborationOffering } from "@/lib/types";
import {
  resolveSubmissionIdempotencyState,
  type SubmissionIdempotencyState,
} from "@/lib/utils/submissionIdempotency";
import { createCollaborationWriteIdempotencyKey } from "@/services/api/collaborations";
import { useModalAccessibility } from "@/components/ui/useModalAccessibility";

interface CollaborationApplicationModalProps {
  isOpen: boolean;
  onClose: () => void;
  listingId: string;
  onSubmit: (
    data: CollaborationApplicationData,
    options: CollaborationApplicationSubmissionOptions,
  ) => Promise<void>;
  compensationOptions?: CollaborationOffering[];
  creatorPlatforms?: string[];
  isCovered?: boolean;
  initialData?: CollaborationApplicationData;
}

export interface CollaborationApplicationData {
  compensationOptionId: string;
  whyGreatFit: string;
  travelDateFrom?: string;
  travelDateTo?: string;
  preferredMonths: string[];
  platformDeliverables: PlatformDeliverable[];
  consent: boolean;
}

export interface CollaborationApplicationSubmissionOptions {
  idempotencyKey: string;
}

const getMonthsInRange = (fromStr: string, toStr: string): string[] => {
  const from = new Date(fromStr);
  const to = new Date(toStr);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return [];

  const months = [];
  const current = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1);

  // Use a limit to prevent infinite loops if dates are somehow broken
  let safetyCounter = 0;
  while (current.getTime() <= end && safetyCounter < 24) {
    months.push(MONTHS_ABBR[current.getUTCMonth()]);
    current.setUTCMonth(current.getUTCMonth() + 1);
    safetyCounter++;
  }
  return Array.from(new Set(months));
};

function formatCompensationOption(option: CollaborationOffering): string {
  switch (option.collaboration_type) {
    case "Free Stay":
      return option.free_stay_max_nights
        ? `Up to ${option.free_stay_max_nights} night${option.free_stay_max_nights === 1 ? "" : "s"}`
        : "Complimentary stay";
    case "Paid":
      return option.paid_max_amount
        ? `Up to ${option.paid_max_amount} ${option.currency ?? ""}`.trim()
        : "Paid collaboration";
    case "Discount":
      return option.discount_percentage
        ? `${option.discount_percentage}% stay discount`
        : "Discounted stay";
    case "Affiliate":
      return option.commission_percentage
        ? `${option.commission_percentage}% commission`
        : "Affiliate commission";
  }
}

export function CollaborationApplicationModal({
  isOpen,
  onClose,
  listingId,
  onSubmit,
  compensationOptions = [],
  creatorPlatforms = [],
  isCovered = false,
  initialData,
}: CollaborationApplicationModalProps) {
  const defaultCompensationOptionId =
    compensationOptions.length === 1 ? compensationOptions[0]?.id || "" : "";
  const [selectedCompensationOptionId, setSelectedCompensationOptionId] = useState(
    initialData?.compensationOptionId ?? defaultCompensationOptionId,
  );
  const [whyGreatFit, setWhyGreatFit] = useState(initialData?.whyGreatFit ?? "");
  const [travelDateFrom, setTravelDateFrom] = useState(initialData?.travelDateFrom ?? "");
  const [travelDateTo, setTravelDateTo] = useState(initialData?.travelDateTo ?? "");
  const [preferredMonths, setPreferredMonths] = useState<string[]>(
    initialData?.preferredMonths ?? [],
  );
  const [consent, setConsent] = useState(initialData?.consent ?? false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submissionRef = useRef<SubmissionIdempotencyState | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const {
    platformDeliverables,
    customDeliverableInput,
    setCustomDeliverableInput,
    handlePlatformToggle,
    handleDeliverableQuantityChange,
    handleAddCustomDeliverable,
    handleRemoveCustomDeliverable,
    isPlatformSelected,
    getPlatformDeliverables,
    resetDeliverables,
  } = usePlatformDeliverables(initialData?.platformDeliverables);

  const resetForm = () => {
    setWhyGreatFit("");
    setTravelDateFrom("");
    setTravelDateTo("");
    setPreferredMonths([]);
    setSelectedCompensationOptionId(defaultCompensationOptionId);
    resetDeliverables();
    setConsent(false);
    setErrorMessage(null);
    submissionRef.current = null;
  };

  const handleCancel = () => {
    if (isSubmitting) return;
    resetForm();
    onClose();
  };

  useModalAccessibility({ isOpen, onClose: handleCancel, dialogRef, isInert: isCovered });

  if (!isOpen) return null;

  const selectedCompensationOption = compensationOptions.find(
    (option) => option.id === selectedCompensationOptionId,
  );
  const fallbackStayOption = compensationOptions.find(
    (option) => option.free_stay_min_nights || option.free_stay_max_nights,
  );
  const availableMonths =
    selectedCompensationOption?.availability_months ??
    Array.from(new Set(compensationOptions.flatMap((option) => option.availability_months)));
  const requiredPlatforms =
    selectedCompensationOption?.platforms ??
    Array.from(new Set(compensationOptions.flatMap((option) => option.platforms)));
  const maxNights = selectedCompensationOption
    ? (selectedCompensationOption.free_stay_max_nights ?? undefined)
    : (fallbackStayOption?.free_stay_max_nights ?? undefined);
  const minNights = selectedCompensationOption
    ? (selectedCompensationOption.free_stay_min_nights ?? undefined)
    : (fallbackStayOption?.free_stay_min_nights ?? undefined);
  const normalizedAvailable = availableMonths.map((m) => getMonthAbbr(m));

  const handleMonthToggle = (month: string) => {
    setErrorMessage(null);
    setPreferredMonths((prev) =>
      prev.includes(month) ? prev.filter((m) => m !== month) : [...prev, month],
    );
  };

  const isMonthAvailable = (month: string): boolean => {
    return availableMonths.length === 0 || normalizedAvailable.includes(month);
  };

  const filterPlatforms = (p: string): boolean => {
    if (!selectedCompensationOption) return false;
    if (p === "Content Package") return true;
    const platformMatch = (list: string[], key: string) =>
      list.includes(key) ||
      list.some((item) => item.toLowerCase() === key.toLowerCase()) ||
      (key === "YouTube" && list.includes("YT"));
    const isHotelDesired = requiredPlatforms.length === 0 || platformMatch(requiredPlatforms, p);
    const isCreatorActive = creatorPlatforms.length === 0 || platformMatch(creatorPlatforms, p);
    return isHotelDesired && isCreatorActive;
  };

  const handleSubmit = async () => {
    setErrorMessage(null);

    const validPlatformDeliverables = platformDeliverables.filter(
      (pd) => pd.deliverables.length > 0,
    );

    if (
      !selectedCompensationOptionId ||
      !whyGreatFit.trim() ||
      validPlatformDeliverables.length === 0 ||
      !consent
    ) {
      return;
    }

    // Nights Validation — creator cannot request more nights than hotel offers
    if (travelDateFrom && travelDateTo) {
      const from = new Date(travelDateFrom);
      const to = new Date(travelDateTo);
      if (!isNaN(from.getTime()) && !isNaN(to.getTime())) {
        const nights = Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
        if (nights <= 0) {
          setErrorMessage("The end date must be after the start date.");
          return;
        }
        if (maxNights && nights > maxNights) {
          setErrorMessage(
            `This hotel offers a maximum of ${maxNights} night${maxNights === 1 ? "" : "s"}. Please shorten your stay.`,
          );
          return;
        }
        if (minNights && nights > 0 && nights < minNights) {
          setErrorMessage(
            `This hotel requires a minimum of ${minNights} night${minNights === 1 ? "" : "s"}. Please extend your stay.`,
          );
          return;
        }
      }
    }

    // Availability Validation
    if (availableMonths.length > 0 && availableMonths.length < 12) {
      let requestedMonths: string[] = [];

      if (travelDateFrom && travelDateTo) {
        requestedMonths = getMonthsInRange(travelDateFrom, travelDateTo);
      } else if (travelDateFrom || travelDateTo) {
        const date = new Date(travelDateFrom || travelDateTo);
        if (!isNaN(date.getTime())) {
          requestedMonths = [MONTHS_ABBR[date.getUTCMonth()]];
        }
      } else if (preferredMonths.length > 0) {
        requestedMonths = preferredMonths;
      }

      if (requestedMonths.length > 0) {
        const invalidMonths = requestedMonths.filter((m) => !normalizedAvailable.includes(m));
        if (invalidMonths.length > 0) {
          setErrorMessage(
            `The hotel is not available in: ${invalidMonths.join(", ")}. Please select dates within their availability.`,
          );
          return;
        }
      }
    }

    const application = {
      compensationOptionId: selectedCompensationOptionId,
      whyGreatFit,
      travelDateFrom: travelDateFrom || undefined,
      travelDateTo: travelDateTo || undefined,
      preferredMonths,
      platformDeliverables: validPlatformDeliverables,
      consent,
    } satisfies CollaborationApplicationData;
    const submission = resolveSubmissionIdempotencyState(
      submissionRef.current,
      JSON.stringify(application),
      ["application"],
      () => createCollaborationWriteIdempotencyKey("create", listingId),
    );
    submissionRef.current = submission;

    setIsSubmitting(true);
    try {
      await onSubmit(application, { idempotencyKey: submission.keys.application });
      resetForm();
      onClose();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to submit application. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const characterCount = whyGreatFit.length;
  const maxCharacters = 500;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm overflow-y-auto"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) handleCancel();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[95vh] overflow-y-auto my-8"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="collaboration-application-title"
      >
        {/* Modal Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between z-10">
          <h3 id="collaboration-application-title" className="text-2xl font-bold text-gray-900">
            {initialData ? "Edit Request" : "Apply for Collaboration"}
          </h3>
          <button
            type="button"
            onClick={handleCancel}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            aria-label="Close application"
          >
            <XMarkIcon className="w-6 h-6 text-gray-600" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="p-6 space-y-8">
          {/* Why are you a great fit */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label
                htmlFor="application-fit"
                className="block text-base font-medium text-gray-900"
              >
                Why are you a great fit for this collaboration?{" "}
                <span className="text-red-500">*</span>
              </label>
              <span className="text-sm text-gray-500">
                ({characterCount}/{maxCharacters})
              </span>
            </div>
            <Textarea
              id="application-fit"
              value={whyGreatFit}
              onChange={(e) => {
                const value = e.target.value;
                if (value.length <= maxCharacters) {
                  setWhyGreatFit(value);
                }
              }}
              rows={6}
              placeholder="Share your content style, audience demographics, and why you're excited about this hotel..."
              className="resize-y"
            />
          </div>

          {/* Compensation option */}
          {compensationOptions.length > 1 && (
            <fieldset>
              <legend className="mb-3 text-base font-medium text-gray-900">
                Choose your compensation <span className="text-red-500">*</span>
              </legend>
              <div className="space-y-3">
                {compensationOptions.map((option) => (
                  <label
                    key={option.id}
                    className={`block w-full cursor-pointer rounded-xl border p-4 transition-colors focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2 ${
                      selectedCompensationOptionId === option.id
                        ? "border-primary-600 bg-primary-50"
                        : "border-gray-200 hover:border-primary-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="compensationOption"
                      value={option.id}
                      checked={selectedCompensationOptionId === option.id}
                      onChange={() => {
                        setErrorMessage(null);
                        setSelectedCompensationOptionId(option.id);
                        setTravelDateFrom("");
                        setTravelDateTo("");
                        setPreferredMonths([]);
                        resetDeliverables();
                      }}
                      className="sr-only"
                    />
                    <span className="block font-semibold text-gray-900">
                      {option.collaboration_type}
                    </span>
                    <span className="mt-1 block text-sm text-gray-600">
                      {formatCompensationOption(option)}
                    </span>
                    {option.terms_summary && (
                      <span className="mt-1 block text-sm text-gray-600">
                        {option.terms_summary}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {/* Stay length hint */}
          {(maxNights || minNights) && (
            <div className="px-4 py-3 rounded-xl bg-blue-50 border border-blue-100 text-sm text-blue-900">
              Stay length offered:{" "}
              {minNights && maxNights && minNights !== maxNights
                ? `${minNights}–${maxNights} nights`
                : `up to ${maxNights || minNights} night${(maxNights || minNights) === 1 ? "" : "s"}`}
            </div>
          )}

          {/* Preferred Travel Dates */}
          <DateMonthPicker
            dateFrom={travelDateFrom}
            dateTo={travelDateTo}
            onDateFromChange={(value) => {
              setErrorMessage(null);
              setTravelDateFrom(value);
              if (value && travelDateTo && travelDateTo <= value) {
                setTravelDateTo("");
              }
            }}
            onDateToChange={(value) => {
              setErrorMessage(null);
              setTravelDateTo(value);
            }}
            preferredMonths={preferredMonths}
            onMonthToggle={handleMonthToggle}
            isMonthAvailable={isMonthAvailable}
            dateLabel="Preferred Travel Dates"
          />

          {/* Platforms & Deliverables */}
          <PlatformDeliverablesSelector
            platformDeliverables={platformDeliverables}
            customDeliverableInput={customDeliverableInput}
            onCustomDeliverableInputChange={setCustomDeliverableInput}
            onPlatformToggle={handlePlatformToggle}
            onDeliverableQuantityChange={handleDeliverableQuantityChange}
            onAddCustomDeliverable={handleAddCustomDeliverable}
            onRemoveCustomDeliverable={handleRemoveCustomDeliverable}
            isPlatformSelected={isPlatformSelected}
            getPlatformDeliverables={getPlatformDeliverables}
            filterPlatforms={filterPlatforms}
            label="Platforms & Expected Deliverables"
            customDescription="Add any other content you'd like to offer"
          />

          {/* Consent Checkbox */}
          <label className="p-5 flex items-start gap-4 rounded-2xl border border-gray-200 bg-gray-50/30 cursor-pointer transition-all hover:bg-gray-50/50 focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              className="sr-only"
            />
            <div
              aria-hidden="true"
              className={`mt-0.5 w-6 h-6 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all ${
                consent ? "bg-primary-600 border-primary-600" : "border-primary-400 bg-white"
              }`}
            >
              {consent && <CheckIcon className="w-4 h-4 text-white stroke-[3px]" />}
            </div>
            <span className="text-sm md:text-base text-gray-700 leading-relaxed font-medium">
              I consent to sharing my contact information with the hotel if my application is
              accepted
            </span>
          </label>

          {/* Error Message */}
          {errorMessage && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl animate-in fade-in slide-in-from-top-2 duration-300">
              <p className="text-sm font-semibold text-red-700">{errorMessage}</p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-3 pt-6 border-t border-gray-200">
            <Button variant="outline" onClick={handleCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              isLoading={isSubmitting}
              disabled={
                !selectedCompensationOptionId ||
                !whyGreatFit.trim() ||
                platformDeliverables.filter((pd) => pd.deliverables.length > 0).length === 0 ||
                !consent
              }
            >
              {initialData ? "Save Changes" : "Submit Application"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
