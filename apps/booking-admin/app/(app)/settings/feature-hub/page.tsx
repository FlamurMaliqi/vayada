"use client";

import { FeatureHubPage, type FeatureProduct } from "@vayada/feature-hub";
import { moduleActivationClient } from "@/services/api/moduleActivationClient";

const PRODUCTS: FeatureProduct[] = ["booking_engine"];

export default function BookingFeatureHubRoute() {
  return (
    <FeatureHubPage
      activationClient={moduleActivationClient}
      initialProduct="booking_engine"
      products={PRODUCTS}
    />
  );
}
