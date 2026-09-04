"use client";

import { useCallback, useEffect, useState } from "react";
import { SettingsCard, SettingsLayout, SettingsSection } from "@vayada/settings-ui";

import { getPmsSettingsSections } from "@/lib/settings/navigation";
import { useTranslation } from "@/lib/i18n";
import { listPmsProperties, type PmsPropertySummary } from "@/services/api/pmsPropertyClient";
import {
  getPmsStaffRoster,
  updatePmsStaffStatus,
  type PmsStaffMember,
} from "@/services/api/pmsStaffClient";

const roleLabelKeys: Record<PmsStaffMember["roleKey"], string> = {
  hotel_manager: "settings.team.roleManager",
  front_desk: "settings.team.roleFrontDesk",
  housekeeping: "settings.team.roleHousekeeping",
  hotel_custom: "settings.team.roleCustom",
};

export default function TeamSettingsPage() {
  const { t, locale } = useTranslation();
  const sections = getPmsSettingsSections(false, t);
  const [members, setMembers] = useState<PmsStaffMember[]>([]);
  const [properties, setProperties] = useState<PmsPropertySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    memberId: string;
    type: "error" | "success";
    message: string;
  } | null>(null);

  const loadRoster = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextMembers, nextProperties] = await Promise.all([
        getPmsStaffRoster(),
        listPmsProperties().catch(() => []),
      ]);
      setMembers(nextMembers);
      setProperties(nextProperties);
    } catch {
      setError(t("settings.team.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const changeStatus = async (member: PmsStaffMember) => {
    const nextStatus = member.status === "active" ? "deactivated" : "active";
    const label = member.name || member.email;
    if (
      nextStatus === "deactivated" &&
      !window.confirm(t("settings.team.deactivateConfirm", { name: label }))
    ) {
      return;
    }

    setUpdatingMemberId(member.id);
    setActionFeedback(null);
    try {
      const updated = await updatePmsStaffStatus(member.id, nextStatus);
      setMembers((current) =>
        current.map((item) =>
          item.id === updated.membershipId ? { ...item, status: updated.status } : item,
        ),
      );
      setActionFeedback({
        memberId: member.id,
        type: "success",
        message: t(
          updated.status === "active"
            ? "settings.team.reactivatedSuccess"
            : "settings.team.deactivatedSuccess",
          { name: label },
        ),
      });
    } catch {
      setActionFeedback({
        memberId: member.id,
        type: "error",
        message: t("settings.team.updateError", { name: label }),
      });
    } finally {
      setUpdatingMemberId(null);
    }
  };

  const propertyNames = new Map(properties.map((property) => [property.id, property.name]));

  return (
    <SettingsLayout title={t("settings.title")} sections={sections} activeId="team">
      <SettingsSection
        id="team"
        title={t("settings.navigation.team")}
        description={t("settings.team.description")}
      >
        {loading ? (
          <SettingsCard>
            <p role="status" className="text-sm text-gray-500">
              {t("settings.team.loading")}
            </p>
          </SettingsCard>
        ) : error ? (
          <SettingsCard>
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-red-600">{error}</p>
              <button
                type="button"
                onClick={() => void loadRoster()}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
              >
                {t("settings.retry")}
              </button>
            </div>
          </SettingsCard>
        ) : members.length === 0 ? (
          <SettingsCard>
            <p className="text-sm font-medium text-gray-900">{t("settings.team.empty")}</p>
            <p className="mt-1 text-sm text-gray-500">{t("settings.team.emptyDescription")}</p>
          </SettingsCard>
        ) : (
          <SettingsCard contentClassName="p-0 md:p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-gray-100 bg-gray-50/60 text-xs font-medium text-gray-500">
                  <tr>
                    <th scope="col" className="px-4 py-3 md:px-5">
                      {t("settings.team.member")}
                    </th>
                    <th scope="col" className="px-4 py-3">
                      {t("settings.team.role")}
                    </th>
                    <th scope="col" className="px-4 py-3">
                      {t("settings.team.properties")}
                    </th>
                    <th scope="col" className="px-4 py-3">
                      {t("bookings.tableStatus")}
                    </th>
                    <th scope="col" className="px-4 py-3 md:px-5">
                      {t("settings.team.lastActive")}
                    </th>
                    <th scope="col" className="px-4 py-3 md:px-5">
                      {t("settings.team.actions")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {members.map((member) => (
                    <tr key={member.id}>
                      <td className="px-4 py-3 md:px-5">
                        <p className="font-medium text-gray-900">{member.name || member.email}</p>
                        {member.name && <p className="text-xs text-gray-500">{member.email}</p>}
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {t(roleLabelKeys[member.roleKey])}
                      </td>
                      <td className="max-w-64 px-4 py-3 text-gray-700">
                        {member.propertyIds
                          .map((propertyId) => propertyNames.get(propertyId) ?? propertyId)
                          .join(", ")}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(member.status)}`}
                        >
                          {statusLabel(member.status, t)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 md:px-5">
                        {formatLastActive(member.lastActiveAt, locale, t)}
                      </td>
                      <td className="px-4 py-3 md:px-5">
                        {member.status === "pending" ? (
                          <span className="text-xs text-gray-500">
                            {t("settings.team.invitationPending")}
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={updatingMemberId !== null}
                            onClick={() => void changeStatus(member)}
                            aria-busy={updatingMemberId === member.id}
                            aria-label={
                              updatingMemberId === member.id
                                ? t("settings.team.savingStatus", {
                                    name: member.name || member.email,
                                  })
                                : t(
                                    member.status === "active"
                                      ? "settings.team.deactivateNamed"
                                      : "settings.team.reactivateNamed",
                                    { name: member.name || member.email },
                                  )
                            }
                            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {updatingMemberId === member.id
                              ? t("common.saving")
                              : member.status === "active"
                                ? t("settings.team.deactivate")
                                : t("settings.team.reactivate")}
                          </button>
                        )}
                        {actionFeedback?.memberId === member.id && (
                          <p
                            role={actionFeedback.type === "error" ? "alert" : "status"}
                            className={`mt-1 text-xs ${actionFeedback.type === "error" ? "text-red-600" : "text-emerald-700"}`}
                          >
                            {actionFeedback.message}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SettingsCard>
        )}
      </SettingsSection>
    </SettingsLayout>
  );
}

function statusLabel(status: PmsStaffMember["status"], t: (key: string) => string): string {
  return t(`settings.team.status${status[0]!.toUpperCase()}${status.slice(1)}`);
}

function statusClass(status: PmsStaffMember["status"]): string {
  if (status === "active") return "bg-emerald-50 text-emerald-700";
  if (status === "pending") return "bg-amber-50 text-amber-700";
  return "bg-gray-100 text-gray-600";
}

function formatLastActive(
  value: string | null,
  locale: string,
  t: (key: string) => string,
): string {
  return value
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value))
    : t("settings.team.notYet");
}
