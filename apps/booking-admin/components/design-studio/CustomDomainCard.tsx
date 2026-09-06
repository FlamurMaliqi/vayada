"use client";

import { useTranslation } from "@/lib/i18n";
import type { CustomDomainStatus } from "@/services/settings";

interface CustomDomainCardProps {
  bookingUrl: string;
  domainInput: string;
  domainStatus: CustomDomainStatus | null;
  saving: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onDomainInputChange: (value: string) => void;
  onRefresh: () => void;
}

export default function CustomDomainCard({
  bookingUrl,
  domainInput,
  domainStatus,
  saving,
  onConnect,
  onDisconnect,
  onDomainInputChange,
  onRefresh,
}: CustomDomainCardProps) {
  const { t } = useTranslation();
  const connected = domainStatus?.sslStatus === "active";
  const verifying = saving || domainStatus?.status === "pending";
  const statusLabel = connected
    ? t("settings.billing.connected")
    : verifying
      ? t("settings.totp.confirming")
      : t("admin.notConnected");
  const statusColor = connected ? "bg-green-500" : verifying ? "bg-yellow-500" : "bg-gray-400";

  return (
    <>
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-[13px] font-semibold text-gray-900">{t("admin.currentBookingURL")}</h2>
        <p className="mt-0.5 text-[12px] text-gray-500">
          {t("admin.yourSlugComesFromThePropertyName")}
        </p>
        <div className="mt-3 truncate rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-700">
          {bookingUrl || t("admin.bookingURLUnavailable")}
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-[13px] font-semibold text-gray-900">
          {t("settings.booking.customDomain")}
        </h2>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={domainInput}
            onChange={(event) => onDomainInputChange(event.target.value)}
            placeholder="booking.yourdomain.com"
            disabled={saving}
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50"
          />
          <button
            type="button"
            onClick={onConnect}
            disabled={saving || !domainInput.trim()}
            className="rounded-lg bg-primary-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-primary-700 disabled:opacity-60"
          >
            {t("settings.booking.connectDomain")}
          </button>
        </div>

        <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3">
          <p className="text-[12px] font-medium text-gray-900">{t("admin.dnsSetup")}</p>
          <p className="mt-1 text-[12px] leading-5 text-gray-600">
            {t("admin.addACNAMERecordForYourSubdomainPointingTo")}{" "}
            <code className="text-gray-900">custom.booking.vayada.com</code>
            {t("admin.propagationUsuallyTakes15MinutesUpTo48Hours")}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700">
              <span className={`h-2 w-2 rounded-full ${statusColor}`} />
              {statusLabel}
            </span>
            {domainStatus?.domain && (
              <p className="mt-1 truncate text-[11px] text-gray-500">{domainStatus.domain}</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onRefresh}
              disabled={saving}
              className="text-[11px] text-primary-600 hover:text-primary-700 disabled:opacity-50"
            >
              {t("settings.booking.refresh")}
            </button>
            {domainStatus?.configured && (
              <button
                type="button"
                onClick={onDisconnect}
                disabled={saving}
                className="text-[11px] text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                {t("admin.removeDomain")}
              </button>
            )}
          </div>
        </div>

        {domainStatus && domainStatus.verificationErrors.length > 0 && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-[12px] text-red-700">
            {t("admin.domainVerificationHasNotCompletedCheckTheCNAMERecordAnd")}
          </p>
        )}
      </div>
    </>
  );
}
