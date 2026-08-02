import { Suspense } from "react";
import { ROUTES } from "@/lib/constants";
import { SharedHotelSetupPage } from "@/components/setup/SharedHotelSetupPage";

type MarketplaceSetupPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function MarketplaceSetupPage({ searchParams }: MarketplaceSetupPageProps) {
  const params = (await searchParams) ?? {};
  const previewRequested =
    process.env.NODE_ENV !== "production" &&
    process.env.HOTEL_SETUP_ADAPTIVE_SHELL_PREVIEW_ENABLED === "true" &&
    firstValue(params._adaptive) === "1";
  const adaptiveShellEnabled =
    process.env.HOTEL_SETUP_ADAPTIVE_SHELL_ENABLED === "true" || previewRequested;

  return (
    <Suspense fallback={<SetupLoading />}>
      <SharedHotelSetupPage
        defaultEntryProduct="marketplace"
        defaultReturnTo={ROUTES.MARKETPLACE}
        adaptiveShellEnabled={adaptiveShellEnabled}
      />
    </Suspense>
  );
}

function SetupLoading() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-gray-50 px-6"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm font-medium text-gray-600">Loading your setup…</p>
    </div>
  );
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
