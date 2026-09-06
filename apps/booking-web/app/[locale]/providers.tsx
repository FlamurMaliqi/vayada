"use client";

import { HotelProvider } from "@/contexts/HotelContext";
import AnalyticsConsent from "@/components/AnalyticsConsent";
import { CurrencyProvider } from "@/contexts/CurrencyContext";

export default function Providers({
  children,
  locale,
  slug,
}: {
  children: React.ReactNode;
  locale: string;
  slug?: string;
}) {
  return (
    <HotelProvider locale={locale} slug={slug}>
      <CurrencyProvider>
        {children}
        <AnalyticsConsent />
      </CurrencyProvider>
    </HotelProvider>
  );
}
