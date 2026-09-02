"use client";

import { useCallback, useEffect, useState } from "react";
import { SettingsCard, SettingsLayout, SettingsSection } from "@vayada/settings-ui";

import { getPmsSettingsSections } from "@/lib/settings/navigation";
import { listPmsProperties, type PmsPropertySummary } from "@/services/api/pmsPropertyClient";
import {
  getPmsStaffRoster,
  updatePmsStaffStatus,
  type PmsStaffMember,
} from "@/services/api/pmsStaffClient";

const sections = getPmsSettingsSections(false);
const roleLabels: Record<PmsStaffMember["roleKey"], string> = {
  hotel_manager: "Manager",
  front_desk: "Front Desk",
  housekeeping: "Housekeeping",
  hotel_custom: "Custom",
};

export default function TeamSettingsPage() {
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
      setError("We couldn’t load your team. Retry to see the current access roster.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const changeStatus = async (member: PmsStaffMember) => {
    const nextStatus = member.status === "active" ? "deactivated" : "active";
    const label = member.name || member.email;
    if (
      nextStatus === "deactivated" &&
      !window.confirm(`Deactivate ${label}? They will lose PMS access until reactivated.`)
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
        message: `${label} ${updated.status === "active" ? "reactivated" : "deactivated"}.`,
      });
    } catch {
      setActionFeedback({
        memberId: member.id,
        type: "error",
        message: `Couldn’t update ${label}. Try again.`,
      });
    } finally {
      setUpdatingMemberId(null);
    }
  };

  const propertyNames = new Map(properties.map((property) => [property.id, property.name]));

  return (
    <SettingsLayout title="Settings" sections={sections} activeId="team">
      <SettingsSection
        id="team"
        title="Team & Roles"
        description="Review staff access across the properties in this workspace."
      >
        {loading ? (
          <SettingsCard>
            <p role="status" className="text-sm text-gray-500">
              Loading team members…
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
                Retry
              </button>
            </div>
          </SettingsCard>
        ) : members.length === 0 ? (
          <SettingsCard>
            <p className="text-sm font-medium text-gray-900">No team members yet</p>
            <p className="mt-1 text-sm text-gray-500">
              Staff members and pending invitations will appear here.
            </p>
          </SettingsCard>
        ) : (
          <SettingsCard contentClassName="p-0 md:p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-gray-100 bg-gray-50/60 text-xs font-medium text-gray-500">
                  <tr>
                    <th scope="col" className="px-4 py-3 md:px-5">
                      Team member
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Role
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Properties
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-3 md:px-5">
                      Last active
                    </th>
                    <th scope="col" className="px-4 py-3 md:px-5">
                      Actions
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
                      <td className="px-4 py-3 text-gray-700">{roleLabels[member.roleKey]}</td>
                      <td className="max-w-64 px-4 py-3 text-gray-700">
                        {member.propertyIds
                          .map((propertyId) => propertyNames.get(propertyId) ?? propertyId)
                          .join(", ")}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(member.status)}`}
                        >
                          {statusLabel(member.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 md:px-5">
                        {formatLastActive(member.lastActiveAt)}
                      </td>
                      <td className="px-4 py-3 md:px-5">
                        {member.status === "pending" ? (
                          <span className="text-xs text-gray-500">Invitation pending</span>
                        ) : (
                          <button
                            type="button"
                            disabled={updatingMemberId !== null}
                            onClick={() => void changeStatus(member)}
                            aria-busy={updatingMemberId === member.id}
                            aria-label={
                              updatingMemberId === member.id
                                ? `Saving status for ${member.name || member.email}`
                                : `${member.status === "active" ? "Deactivate" : "Reactivate"} ${member.name || member.email}`
                            }
                            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {updatingMemberId === member.id
                              ? "Saving…"
                              : member.status === "active"
                                ? "Deactivate"
                                : "Reactivate"}
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

function statusLabel(status: PmsStaffMember["status"]): string {
  return status === "deactivated" ? "Deactivated" : status[0]!.toUpperCase() + status.slice(1);
}

function statusClass(status: PmsStaffMember["status"]): string {
  if (status === "active") return "bg-emerald-50 text-emerald-700";
  if (status === "pending") return "bg-amber-50 text-amber-700";
  return "bg-gray-100 text-gray-600";
}

function formatLastActive(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value))
    : "Not yet";
}
