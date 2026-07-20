"use client";

import { Button } from "@/components/ui";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon } from "@heroicons/react/24/outline";
import type { FormNavigationButtonsProps } from "./types";

export function FormNavigationButtons({
  currentStep,
  totalSteps,
  submitting,
  canProceed,
  onPrevious,
  submitLabel = "Complete Profile",
  prominentFirstStep = false,
  stackOnMobile = false,
}: FormNavigationButtonsProps) {
  const isLastStep = currentStep === totalSteps;
  const isFirstStep = currentStep === 1;
  const useProminentButton = isFirstStep && prominentFirstStep;

  return (
    <div
      className={`flex gap-4 ${
        isFirstStep
          ? stackOnMobile
            ? "flex-col items-stretch justify-center pt-1 sm:flex-row sm:items-center"
            : "items-center justify-center pt-1"
          : stackOnMobile
            ? "flex-col-reverse items-stretch border-t border-gray-100 pt-4 sm:flex-row sm:items-center sm:justify-between"
            : "items-center justify-between border-t border-gray-100 pt-4"
      }`}
    >
      {currentStep > 1 && (
        <Button
          type="button"
          variant="outline"
          onClick={onPrevious}
          className={`gap-2 rounded-full border-gray-200 px-5 py-3 ${
            stackOnMobile ? "w-full sm:w-auto" : ""
          }`}
        >
          <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
          Previous
        </Button>
      )}
      {!isFirstStep && <div className={stackOnMobile ? "hidden sm:block sm:flex-1" : "flex-1"} />}
      <Button
        type="submit"
        variant="primary"
        size={useProminentButton ? "lg" : "md"}
        className={`gap-2 rounded-full font-semibold shadow-[0_14px_30px_-18px_rgba(37,99,235,0.8)] transition hover:-translate-y-0.5 ${
          stackOnMobile ? "w-full sm:w-auto" : ""
        } ${useProminentButton ? "px-8" : "px-6 py-3"}`}
        disabled={submitting || !canProceed}
      >
        {submitting ? (
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            Saving...
          </span>
        ) : isLastStep ? (
          <span className="flex items-center justify-center gap-2">
            <CheckIcon className="h-5 w-5" aria-hidden="true" />
            {submitLabel}
          </span>
        ) : (
          <span className="flex items-center justify-center gap-2">
            Continue
            <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
      </Button>
    </div>
  );
}
