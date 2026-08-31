"use client";

import { FeatureHubPage } from "@vayada/feature-hub";
import { moduleActivationClient } from "@/services/api/moduleActivationClient";

export default function BookingFeatureHubRoute() {
  return (
    <FeatureHubPage activationClient={moduleActivationClient} initialProduct="booking_engine" />
  );
}
