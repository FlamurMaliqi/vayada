"use client";

import { FeatureHubPage } from "@vayada/feature-hub";
import { moduleActivationClient } from "@/services/api/moduleActivationClient";

export default function PmsFeatureHubRoute() {
  return <FeatureHubPage activationClient={moduleActivationClient} initialProduct="pms" />;
}
