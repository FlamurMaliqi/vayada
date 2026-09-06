"use client";

import { useTranslation } from "@/lib/i18n";
import { FeatureHubPage } from "@vayada/feature-hub";
import { moduleActivationClient } from "@/services/api/moduleActivationClient";

export default function BookingFeatureHubRoute() {
  const { t } = useTranslation();
  return (
    <FeatureHubPage
      translate={t}
      activationClient={moduleActivationClient}
      initialProduct="booking_engine"
    />
  );
}
