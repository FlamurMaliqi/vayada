"use client";

import { CalendarDaysIcon, CheckIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";

import type { FontPairing } from "./bookingPageBranding";

export function BookingPagePreview({
  bookingUrl = "yourhotel.vayada.com",
  className = "",
  currency,
  defaultLanguage,
  font,
  headerLogo,
  heroHeading,
  heroImage,
  heroSubtext,
  primaryColor,
  propertyName,
}: {
  bookingUrl?: string;
  className?: string;
  currency: string;
  defaultLanguage: string;
  font: Pick<FontPairing, "headingFamily" | "bodyFamily">;
  headerLogo?: string;
  heroHeading: string;
  heroImage: string;
  heroSubtext: string;
  primaryColor: string;
  propertyName: string;
}) {
  const accent = /^#[0-9a-f]{6}$/i.test(primaryColor) ? primaryColor : "#4F46E5";
  const tint = `${accent}18`;

  return (
    <div
      aria-label="Live booking page preview"
      className={`min-h-[360px] overflow-hidden rounded-2xl border border-gray-200 bg-white ${className}`}
    >
      <div className="border-b border-gray-200 bg-gray-50 px-3 py-2">
        <div className="truncate rounded-md border border-gray-200 bg-white px-3 py-1 text-center text-[11px] text-gray-500">
          {bookingUrl.replace(/^https?:\/\//, "")}
        </div>
      </div>

      <div
        className="max-h-[620px] overflow-y-auto bg-white"
        style={{ fontFamily: font.bodyFamily }}
      >
        <div className="relative h-[260px] w-full bg-gray-300">
          {heroImage ? (
            <img
              alt="Booking page hero preview"
              className="h-full w-full object-cover"
              src={heroImage}
            />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/65" />

          <div className="absolute inset-x-0 top-0 z-10 flex h-11 items-center justify-between px-4">
            {headerLogo ? (
              <img
                alt={`${propertyName || "Property"} logo`}
                className="max-h-6 max-w-[140px] object-contain object-left"
                src={headerLogo}
              />
            ) : (
              <span className="truncate text-[11px] font-semibold text-white">
                {propertyName || "Your Hotel"}
              </span>
            )}
            <div className="flex items-center gap-1.5">
              <span
                className="rounded-full px-2.5 py-1 text-[9px] font-semibold text-white"
                style={{ backgroundColor: accent }}
              >
                Contact
              </span>
              <span className="hidden rounded-full border border-white/60 px-2.5 py-1 text-[9px] font-semibold text-white sm:inline">
                Refer a Guest
              </span>
              <span className="rounded-full border border-white/60 px-2 py-1 text-[9px] font-semibold text-white">
                {(defaultLanguage || "en").toUpperCase()}
              </span>
              <span className="rounded-full border border-white/60 px-2 py-1 text-[9px] font-semibold text-white">
                {currency || "EUR"}
              </span>
            </div>
          </div>

          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            <h2 className="mb-1.5 text-2xl text-white" style={{ fontFamily: font.headingFamily }}>
              {heroHeading || propertyName || "Your Hotel Name"}
            </h2>
            <p className="max-w-sm text-[11px] leading-relaxed text-white/90">
              {heroSubtext || "Your hotel tagline will appear here."}
            </p>
          </div>
        </div>

        <div className="relative z-20 mx-auto -mt-6 max-w-[92%]">
          <div className="flex items-center gap-2 rounded-xl border border-gray-100 bg-white px-3 py-2.5 shadow-lg">
            <PreviewSearchValue
              accent={accent}
              icon={<CalendarDaysIcon className="h-3.5 w-3.5" />}
              label="Your stay"
              subvalue="5 nights"
              tint={tint}
              value="Feb 13 - Feb 18"
            />
            <div className="h-8 w-px bg-gray-200" />
            <PreviewSearchValue
              accent={accent}
              icon={<UserGroupIcon className="h-3.5 w-3.5" />}
              label="Guests"
              subvalue="1 room"
              tint={tint}
              value="2 adults"
            />
            <button
              className="ml-auto shrink-0 rounded-full px-3 py-2 text-[9px] font-semibold text-white"
              style={{ backgroundColor: accent }}
              tabIndex={-1}
              type="button"
            >
              Check Availability
            </button>
          </div>
        </div>

        <div className="px-4 py-5">
          <h3 className="mb-3 text-sm text-gray-900" style={{ fontFamily: font.headingFamily }}>
            Available Accommodations
          </h3>
          <div className="overflow-hidden rounded-xl border border-gray-200">
            <div className="flex min-h-28">
              <div className="w-32 shrink-0 bg-gray-200 sm:w-40">
                {heroImage ? (
                  <img alt="Room preview" className="h-full w-full object-cover" src={heroImage} />
                ) : null}
              </div>
              <div className="min-w-0 flex-1 p-3">
                <h4 className="text-[12px] font-bold text-gray-900">Your featured room</h4>
                <p className="mt-1 text-[9px] text-gray-500">For 2 guests</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {["Best rate", "Instant confirmation"].map((feature) => (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-1.5 py-0.5 text-[8px] text-gray-700"
                      key={feature}
                    >
                      <CheckIcon className="h-2.5 w-2.5" style={{ color: accent }} />
                      {feature}
                    </span>
                  ))}
                </div>
                <div
                  className="mt-2 rounded-lg border-2 px-2.5 py-2"
                  style={{ borderColor: accent }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[9px] font-bold text-gray-900">Flexible rate</span>
                    <span className="text-[11px] font-bold" style={{ color: accent }}>
                      {currency || "EUR"} 120
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewSearchValue({
  accent,
  icon,
  label,
  subvalue,
  tint,
  value,
}: {
  accent: string;
  icon: ReactNode;
  label: string;
  subvalue: string;
  tint: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span
        className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-full sm:flex"
        style={{ backgroundColor: tint, color: accent }}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[8px] font-medium uppercase tracking-wide text-gray-500">
          {label}
        </span>
        <span className="block truncate text-[10px] font-semibold text-gray-900">{value}</span>
        <span className="block text-[8px] text-gray-500">{subvalue}</span>
      </span>
    </div>
  );
}
