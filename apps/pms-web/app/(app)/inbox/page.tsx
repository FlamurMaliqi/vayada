"use client";

import { Suspense } from "react";

import InboxWorkspace from "@/components/inbox/InboxWorkspace";
import { useTranslation } from "@/lib/i18n";

export default function InboxPage() {
  return (
    <Suspense fallback={<InboxPageSkeleton />}>
      <InboxWorkspace />
    </Suspense>
  );
}

function InboxPageSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      className="h-[calc(100dvh-3rem)] animate-pulse bg-white"
      role="status"
      aria-label={t("inbox.loadingInbox")}
    >
      <div className="h-full w-full max-w-sm border-r border-gray-200 p-4">
        <div className="h-5 w-20 rounded bg-gray-200" />
        <div className="mt-6 h-9 rounded bg-gray-100" />
      </div>
    </div>
  );
}
