"use client";

import { OnboardingShell } from "@/components/onboarding/OnboardingShell";

export function LoadingScreen() {
  return (
    <OnboardingShell
      currentStep={2}
      title="Loading your setup"
      description="We are checking your onboarding progress before continuing."
    >
      <div className="flex min-h-80 items-center justify-center rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950" />
      </div>
    </OnboardingShell>
  );
}
