"use client";

import { OnboardingShell } from "@/components/onboarding/OnboardingShell";

export function LoadingScreen() {
  return (
    <OnboardingShell
      currentStep={2}
      title="Loading your setup"
      description="We are checking your onboarding progress before continuing."
      showProgress={false}
    >
      <div className="flex min-h-80 items-center justify-center rounded-3xl border border-gray-100 bg-white shadow-[0_24px_80px_-50px_rgba(15,23,42,0.55)]">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950"
          role="status"
          aria-label="Loading profile setup"
        />
      </div>
    </OnboardingShell>
  );
}
