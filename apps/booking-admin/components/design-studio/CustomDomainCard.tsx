"use client";

import { useTranslation } from "@/lib/i18n";
import type { CustomDomainStatus } from "@/services/settings";

interface CustomDomainCardProps {
  domainInput: string;
  domainStatus: CustomDomainStatus | null;
  saving: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onDomainInputChange: (value: string) => void;
  onRefresh: () => void;
}

export default function CustomDomainCard({
  domainInput,
  domainStatus,
  saving,
  onConnect,
  onDisconnect,
  onDomainInputChange,
  onRefresh,
}: CustomDomainCardProps) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-[13px] font-semibold text-gray-900">
        {t("settings.booking.customDomain")}
      </h2>
      {domainStatus?.configured ? (
        <div className="mt-3 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[13px] font-medium text-gray-900">{domainStatus.domain}</span>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                domainStatus.sslStatus === "active"
                  ? "bg-green-100 text-green-700"
                  : domainStatus.status === "pending"
                    ? "bg-yellow-100 text-yellow-700"
                    : "bg-gray-100 text-gray-700"
              }`}
            >
              {domainStatus.sslStatus === "active"
                ? t("settings.booking.active")
                : domainStatus.status === "pending"
                  ? t("settings.booking.pendingDns")
                  : domainStatus.sslStatus || t("settings.booking.checking")}
            </span>
            <button
              type="button"
              onClick={onRefresh}
              className="text-[11px] text-primary-600 hover:text-primary-700"
            >
              {t("settings.booking.refresh")}
            </button>
          </div>

          {domainStatus.sslStatus !== "active" && domainStatus.dnsRecords.length > 0 && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <p className="mb-2 text-[13px] font-medium text-blue-900">
                {t("settings.booking.dnsSetupRequired")}
              </p>
              <p className="mb-2 text-[13px] text-blue-700">
                {t("settings.booking.dnsInstructions")}
              </p>
              {domainStatus.dnsRecords.map((record) => (
                <div
                  key={`${record.type}:${record.name}`}
                  className="space-y-1 rounded bg-white p-3 font-mono text-[11px] text-gray-800"
                >
                  <div>
                    <span className="text-gray-500">{t("settings.booking.dnsType")}</span>{" "}
                    {record.type}
                  </div>
                  <div>
                    <span className="text-gray-500">{t("settings.booking.dnsName")}</span>{" "}
                    {record.name}
                  </div>
                  <div>
                    <span className="text-gray-500">{t("settings.booking.dnsTarget")}</span>{" "}
                    {record.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          {domainStatus.verificationErrors.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-[13px] text-red-700">
                {domainStatus.verificationErrors.join(", ")}
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={onDisconnect}
            disabled={saving}
            className="rounded-lg border border-red-200 px-4 py-2 text-[13px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
          >
            {t("settings.booking.removeDomain")}
          </button>
        </div>
      ) : (
        <div className="mt-1 space-y-3">
          <p className="text-[13px] text-gray-500">{t("settings.booking.customDomainDesc")}</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={domainInput}
              onChange={(event) => onDomainInputChange(event.target.value)}
              placeholder={t("settings.booking.customDomainPlaceholder")}
              disabled={saving}
              className="flex-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50"
            />
            <button
              type="button"
              onClick={onConnect}
              disabled={saving}
              className="rounded-lg bg-primary-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-primary-700 disabled:opacity-60"
            >
              {t("settings.booking.connectDomain")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
