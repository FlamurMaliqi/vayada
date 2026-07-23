"use client";

import { FeatureHubPage, type FeatureProduct } from "@vayada/feature-hub";
import { moduleActivationClient } from "@/services/api/moduleActivationClient";

const PRODUCTS: FeatureProduct[] = ["pms"];
const UNAVAILABLE_MODULES = ["inbox", "financials"];

export default function PmsFeatureHubRoute() {
  return (
    <FeatureHubPage
      activationClient={moduleActivationClient}
      initialProduct="pms"
      products={PRODUCTS}
      hiddenModuleIds={UNAVAILABLE_MODULES}
    />
  );
}
