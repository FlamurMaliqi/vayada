"use client";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
export default function SelectionUnavailable({
  loading,
  search,
}: {
  loading?: boolean;
  search: string;
}) {
  const t = useTranslations("roomSelection");
  const tc = useTranslations("common");
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-4">
        <p role="status" className="text-gray-600">
          {loading ? tc("loading") : t("unavailable")}
        </p>
        {!loading && (
          <Link
            href={`/?${search}`}
            className="inline-block rounded-full bg-primary-600 px-6 py-3 text-white"
          >
            {tc("checkAvailability")}
          </Link>
        )}
      </div>
    </div>
  );
}
