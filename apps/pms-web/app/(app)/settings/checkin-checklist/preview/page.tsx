"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import {
  CheckinChecklistPreview,
  readChecklistPreviewDraft,
} from "@/components/settings/CheckinChecklistBuilder";
import { CheckinChecklistStep, settingsService } from "@/services/settings";
import { useTranslation } from "@/lib/i18n";

export default function CheckinChecklistPreviewPage() {
  const { t } = useTranslation();
  const [steps, setSteps] = useState<CheckinChecklistStep[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const draft = readChecklistPreviewDraft();
    if (draft) {
      setSteps(draft);
      setLoading(false);
      return;
    }
    settingsService
      .getCheckinChecklist()
      .then((template) => setSteps(template.steps || []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="min-h-[100dvh] bg-gray-50 p-4 md:p-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-gray-500">
              {t("settings.title")} / {t("settings.navigation.checkinChecklist")} /{" "}
              {t("settings.checklist.preview")}
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-gray-950">
              {t("settings.checklist.previewPageTitle")}
            </h1>
          </div>
          <Link
            href="/settings/checkin-checklist"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            {t("settings.checklist.backToSettings")}
          </Link>
        </header>
        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500">
            {t("settings.checklist.loadingPreview")}
          </div>
        ) : (
          <CheckinChecklistPreview steps={steps} />
        )}
      </div>
    </main>
  );
}
