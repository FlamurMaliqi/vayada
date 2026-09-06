"use client";

import Link from "next/link";
import { useTranslation } from "@/lib/i18n";

export default function AffiliatesPage() {
  const { t } = useTranslation();
  return (
    <section className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-xl font-semibold text-gray-900">
        {t("admin.affiliateManagementIsUnavailable")}
      </h1>
      <Link href="/" className="text-sm font-medium text-primary-700 underline">
        {t("layout.sidebar.dashboard")}
      </Link>
    </section>
  );
}
