import { Suspense } from "react";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { ROUTES } from "@/lib/constants";
import { SharedHotelSetupPage } from "@/components/setup/SharedHotelSetupPage";

export default function MarketplaceSetupPage() {
  return (
    <OnboardingShell
      currentStep={3}
      title="Set up your property"
      description="Add the shared details Vayada needs before opening your selected workspace."
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
