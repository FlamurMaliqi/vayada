"use client";

import type { ConsentControls } from "./CookieSettingsModal";
import Link from "next/link";
import { ShieldCheckIcon } from "@heroicons/react/24/outline";

export function CookieBanner({
  controls,
  privacyHref,
}: {
  controls: ConsentControls;
  privacyHref: string;
}) {
  const { showBanner, isLoading, acceptAll, acceptNecessaryOnly, openSettings } = controls;
  if (isLoading) return null;
  if (!showBanner)
    return (
      <button
        id="cookie-settings-trigger"
        type="button"
        onClick={openSettings}
        className="fixed bottom-3 left-3 z-40 rounded-full border border-gray-300 bg-white px-3 py-2 text-xs text-gray-700 shadow-sm focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        Cookie settings
      </button>
    );

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-3 sm:inset-x-auto sm:bottom-5 sm:right-5 sm:block sm:w-[26rem] sm:p-0">
      <section
        role="dialog"
        aria-labelledby="cookie-banner-title"
        aria-describedby="cookie-banner-description"
        className="pointer-events-auto overflow-hidden rounded-2xl border border-border-strong bg-white/95 shadow-elevated backdrop-blur-xl"
      >
        <div className="p-5 sm:p-6">
          <div className="flex items-start gap-3.5">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-50 text-primary-500 ring-1 ring-primary-100">
              <ShieldCheckIcon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2
                id="cookie-banner-title"
                className="font-display text-lg font-semibold tracking-tight text-ink"
              >
                Cookie preferences
              </h2>
              <p
                id="cookie-banner-description"
                className="mt-1.5 text-sm leading-6 text-muted-dark"
              >
                We use necessary cookies to keep Vayada working and optional cookies to improve your
                experience.{" "}
                <Link
                  href={privacyHref}
                  className="font-medium text-primary-600 underline decoration-primary-200 underline-offset-4 transition-colors hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
                >
                  Privacy policy
                </Link>
              </p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={acceptAll}
              className="col-span-2 inline-flex h-11 items-center justify-center rounded-full bg-primary-500 px-5 text-sm font-medium text-white shadow-glow transition-colors hover:bg-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
            >
              Accept all
            </button>
            <button
              type="button"
              onClick={acceptNecessaryOnly}
              className="inline-flex h-10 items-center justify-center rounded-full border border-border-strong bg-white px-4 text-sm font-medium text-ink transition-colors hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
            >
              Necessary only
            </button>
            <button
              type="button"
              onClick={openSettings}
              className="inline-flex h-10 items-center justify-center rounded-full bg-surface-elevated px-4 text-sm font-medium text-ink transition-colors hover:bg-primary-50 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
            >
              Customize
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export default CookieBanner;
