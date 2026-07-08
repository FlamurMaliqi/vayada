import { Suspense } from "react";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { ROUTES } from "@/lib/constants";
import { SharedHotelSetupPage } from "@/components/setup/SharedHotelSetupPage";

export default function MarketplaceSetupPage() {
  return (
    <OnboardingShell
      currentStep={2}
      title="Create your first collaboration listing"
      description="Add the property details creators need before they can evaluate your offer."
    >
      <Suspense fallback={<SetupLoading />}>
        <SharedHotelSetupPage
          defaultEntryProduct="marketplace"
          defaultReturnTo={ROUTES.MARKETPLACE}
          embedded
        />
      </Suspense>
    </OnboardingShell>
  );
}

function SetupLoading() {
  return (
    <div className="flex min-h-80 items-center justify-center rounded-3xl border border-gray-100 bg-white shadow-[0_24px_80px_-50px_rgba(15,23,42,0.55)]">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950" />
    </div>
  );
}
