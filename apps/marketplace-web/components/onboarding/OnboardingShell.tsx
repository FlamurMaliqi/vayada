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
    title: "Choose product",
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
  const progressValue = Math.min(totalSteps, Math.max(0, currentStep));
  const currentStepLabel = Math.min(totalSteps, Math.max(1, currentStep));
  const progressPercent = (progressValue / totalSteps) * 100;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#fbfbfa] text-gray-950">
      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <Image
          src="/vayada-logo.png"
          alt="vayada"
          width={120}
          height={40}
          className="h-8 w-auto"
          priority
        />
        <p className="text-sm font-medium text-gray-500">
          Step {currentStepLabel} of {totalSteps}
        </p>
      </header>

      <div
        className="relative z-10 h-px overflow-hidden bg-gray-100"
        role="progressbar"
        aria-label="Onboarding progress"
        aria-valuenow={progressValue}
        aria-valuemin={0}
        aria-valuemax={totalSteps}
      >
        <div className="h-px bg-primary-600" style={{ width: `${progressPercent}%` }} />
      </div>

      <main className="relative z-10 mx-auto flex min-h-[calc(100vh-82px)] w-full max-w-5xl flex-col items-center justify-center px-5 py-10 sm:px-8">
        <section className="w-full text-center">
          <h1 className="mx-auto max-w-2xl text-4xl font-semibold tracking-normal text-gray-950 sm:text-5xl">
            {title}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-gray-600">{description}</p>
        </section>

        <section className="mt-10 w-full">{children}</section>

        <ol
          className="mt-12 flex items-center justify-center gap-2"
          aria-label="Onboarding progress"
        >
          {MARKETPLACE_ONBOARDING_STEPS.map((step, index) => {
            const stepNumber = index + 1;
            const isCurrent = stepNumber === currentStep;
            const isComplete = stepNumber < currentStep;

            return (
              <li
                key={step.title}
                aria-current={isCurrent ? "step" : undefined}
                title={step.description}
                className={`h-2 rounded-full transition-all duration-300 ${
                  isCurrent || isComplete ? "w-8 bg-gray-950" : "w-2 bg-gray-300"
                }`}
              >
                <span className="sr-only">
                  {step.title}: {step.description}
                </span>
              </li>
            );
          })}
        </ol>
      </main>
    </div>
  );
}
