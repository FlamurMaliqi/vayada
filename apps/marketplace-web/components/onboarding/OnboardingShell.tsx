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
  children: ReactNode;
};

export const MARKETPLACE_ONBOARDING_STEPS: OnboardingStep[] = [
  {
    title: "Pick starting point",
    description: "Choose what you want to launch first.",
  },
  {
    title: "Choose products",
    description: "Pick the Vayada workspace you want to start with.",
  },
  {
    title: "Create first profile",
    description: "Create the first listing or profile people will review.",
  },
];

export function OnboardingShell({
  title,
  description,
  currentStep,
  children,
}: OnboardingShellProps) {
  const totalSteps = MARKETPLACE_ONBOARDING_STEPS.length;
  const currentStepLabel = Math.min(totalSteps, Math.max(1, currentStep));
  const currentStepTitle = MARKETPLACE_ONBOARDING_STEPS[currentStepLabel - 1]?.title;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#fbfbfa] text-gray-950">
      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-center px-5 py-6 sm:px-8">
        <Image
          src="/vayada-logo.png"
          alt="vayada"
          width={120}
          height={40}
          className="h-8 w-auto"
          priority
        />
      </header>

      <main className="relative z-10 mx-auto flex min-h-[calc(100vh-80px)] w-full max-w-6xl flex-col items-center justify-center px-5 py-8 sm:px-8">
        <section className="w-full text-center">
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-normal text-gray-950 sm:text-5xl">
            {title}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-gray-600">{description}</p>
        </section>

        <section className="mt-10 w-full">{children}</section>

        <div className="mt-12 flex flex-col items-center gap-3">
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
      </main>
    </div>
  );
}
