"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import { CheckCircleIcon } from "@heroicons/react/24/outline";

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
    title: "Choose path",
    description: "Tell us if you are joining as a hotel or creator.",
  },
  {
    title: "Build profile",
    description: "Create the first listing or creator profile people will review.",
  },
  {
    title: "Start matching",
    description: "Enter the marketplace ready to invite or apply.",
  },
];

export function OnboardingShell({
  title,
  description,
  currentStep,
  children,
}: OnboardingShellProps) {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-950">
      <div className="grid min-h-screen lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="border-b border-gray-200 bg-white px-4 py-6 sm:px-6 lg:border-b-0 lg:border-r">
          <div className="mx-auto max-w-5xl lg:sticky lg:top-6 lg:max-w-none">
            <Image
              src="/vayada-logo.png"
              alt="vayada"
              width={120}
              height={40}
              className="mb-8 h-10 w-auto"
              priority
            />

            <p className="text-xs font-semibold text-primary-600">Marketplace onboarding</p>
            <h1 className="mt-2 text-2xl font-semibold leading-tight">{title}</h1>
            <p className="mt-3 text-sm leading-6 text-gray-600">{description}</p>

            <ol className="mt-8 space-y-3" aria-label="Onboarding progress">
              {MARKETPLACE_ONBOARDING_STEPS.map((step, index) => {
                const stepNumber = index + 1;
                const isComplete = stepNumber < currentStep;
                const isCurrent = stepNumber === currentStep;

                return (
                  <li
                    key={step.title}
                    aria-current={isCurrent ? "step" : undefined}
                    className={`flex gap-3 rounded-lg p-3 ${
                      isCurrent ? "bg-primary-50" : "bg-transparent"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold ${
                        isComplete || isCurrent
                          ? "bg-primary-600 text-white"
                          : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {isComplete ? <CheckCircleIcon className="h-4 w-4" /> : stepNumber}
                    </span>
                    <span>
                      <span
                        className={`block text-sm font-semibold ${
                          isCurrent || isComplete ? "text-gray-950" : "text-gray-500"
                        }`}
                      >
                        {step.title}
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-gray-500">
                        {step.description}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>

            <div className="mt-8 hidden overflow-hidden rounded-lg lg:block">
              <div className="relative aspect-[4/3]">
                <Image
                  src="/hotel-hero.JPG"
                  alt=""
                  fill
                  sizes="280px"
                  className="object-cover"
                  aria-hidden="true"
                />
                <div className="absolute inset-0 bg-gray-950/20" />
              </div>
            </div>
          </div>
        </aside>

        <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
