"use client";

import { FeatureHubPage, type FeatureProduct } from "@vayada/feature-hub";
import { moduleActivationClient } from "@/services/api/moduleActivationClient";

const PRODUCTS: FeatureProduct[] = ["pms"];

export default function PmsFeatureHubRoute() {
  return (
    <FeatureHubPage
      activationClient={moduleActivationClient}
      initialProduct="pms"
      products={PRODUCTS}
    />
  );
}
