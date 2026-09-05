"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  CheckoutInspectionPreview,
  readCheckoutInspectionPreviewDraft,
} from "@/components/settings/CheckoutInspectionBuilder";
import { CheckoutInspectionStep, settingsService } from "@/services/settings";
import { useTranslation } from "@/lib/i18n";

export default function CheckoutInspectionPreviewPage() {
  const { t } = useTranslation();
  const [steps, setSteps] = useState<CheckoutInspectionStep[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const draft = readCheckoutInspectionPreviewDraft();
    if (draft) {
      setSteps(draft);
      setLoading(false);
      return;
    }
    settingsService
      .getCheckoutInspection()
      .then((template) => setSteps(template.steps || []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-4 text-sm text-gray-500">{t("settings.inspection.loadingPreview")}</div>
    );
  }

  return (
    <main className="min-h-[100dvh] bg-gray-50 p-4 md:p-6">
      <div className="mx-auto max-w-xl space-y-4">
        <div>
          <p className="text-sm text-gray-500">
            {t("settings.title")} / {t("settings.navigation.checkoutInspection")} /{" "}
            {t("settings.inspection.preview")}
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-gray-950">
            {t("settings.inspection.previewPageTitle")}
          </h1>
        </div>
        <CheckoutInspectionPreview steps={steps} />
        <Link
          href="/settings/checkout-inspection"
          className="inline-flex rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          {t("settings.inspection.backToEditor")}
        </Link>
      </div>
    </main>
  );
}
