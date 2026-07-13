"use client";

import type { ReactNode } from "react";
import Image from "next/image";

type OnboardingStep = {
  title: string;
  description: string;
};

type OnboardingShellProps = {
  title: string;
  description: string;
  currentStep: number;
  compact?: boolean;
  showProgress?: boolean;
  children: ReactNode;
};

export const MARKETPLACE_ONBOARDING_STEPS: OnboardingStep[] = [
  {
    title: "Choose account",
    description: "Choose the kind of account you want to create.",
  },
  {
    title: "Account details",
    description: "Add the person Vayada should contact.",
  },
  {
    title: "Choose systems",
    description: "Pick the Vayada systems this business will use.",
  },
];

export function OnboardingShell({
  title,
  description,
  currentStep,
  compact = false,
  showProgress = true,
  children,
}: OnboardingShellProps) {
  const totalSteps = MARKETPLACE_ONBOARDING_STEPS.length;
  const currentStepLabel = Math.min(totalSteps, Math.max(1, currentStep));
  const currentStepTitle = MARKETPLACE_ONBOARDING_STEPS[currentStepLabel - 1]?.title;

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#fbfbfa] text-gray-950">
      <header
        className={`relative z-10 mx-auto flex max-w-6xl items-center justify-center px-5 sm:px-8 ${
          compact ? "py-3" : "py-6"
        }`}
      >
        <Image
          src="/vayada-logo.png"
          alt="vayada"
          width={120}
          height={40}
          className="h-8 w-auto"
          priority
        />
      </header>

      <main
        className={`relative z-10 mx-auto flex min-h-[calc(100vh-80px)] w-full flex-col items-center px-5 sm:px-8 ${
          compact ? "max-w-[960px] justify-center py-6" : "max-w-6xl justify-center py-8"
        }`}
      >
        <section className="w-full text-center">
          <h1
            className={`mx-auto max-w-3xl font-semibold tracking-normal text-gray-950 ${
              compact ? "text-3xl sm:text-4xl" : "text-4xl sm:text-5xl"
            }`}
          >
            {title}
          </h1>
          {description && (
            <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-gray-600">{description}</p>
          )}
        </section>

        <section className={`${compact ? "mt-4" : "mt-10"} w-full`}>{children}</section>

        {showProgress && (
          <div className={`${compact ? "mt-8" : "mt-12"} flex flex-col items-center gap-3`}>
            <p className="text-sm font-semibold text-gray-500">
              Step {currentStepLabel} of {totalSteps}
              {currentStepTitle ? ` · ${currentStepTitle}` : ""}
            </p>
            <ol className="flex items-center justify-center gap-2" aria-label="Onboarding progress">
              {MARKETPLACE_ONBOARDING_STEPS.map((step, index) => {
                const stepNumber = index + 1;
                const isCurrent = stepNumber === currentStepLabel;
                const isComplete = stepNumber < currentStepLabel;

                return (
                  <li
                    key={step.title}
                    aria-current={isCurrent ? "step" : undefined}
                    title={step.description}
                    className={`h-2 rounded-full transition-all duration-300 ${
                      isCurrent || isComplete ? "w-10 bg-primary-600" : "w-3 bg-primary-100"
                    }`}
                  >
                    <span className="sr-only">
                      {step.title}: {step.description}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </main>
    </div>
  );
}
