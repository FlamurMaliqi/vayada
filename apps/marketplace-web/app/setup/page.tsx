import { Suspense } from "react";
import { ROUTES } from "@/lib/constants";
import { SharedHotelSetupPage } from "@/components/setup/SharedHotelSetupPage";

export default function MarketplaceSetupPage() {
  return (
    <Suspense fallback={<SetupLoading />}>
      <SharedHotelSetupPage
        defaultEntryProduct="marketplace"
        defaultReturnTo={ROUTES.MARKETPLACE}
      />
    </Suspense>
  );
}

function SetupLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950" />
    </div>
  );
}
