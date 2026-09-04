import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";

export type PmsStaffMember = {
  id: string;
  name: string | null;
  email: string;
  roleKey: "hotel_manager" | "front_desk" | "housekeeping" | "hotel_custom";
  propertyIds: string[];
  status: "active" | "pending" | "deactivated";
  lastActiveAt: string | null;
};

export async function getPmsStaffRoster(): Promise<PmsStaffMember[]> {
  const response = await pmsOperationsClient.get<{ members: PmsStaffMember[] }>(
    "/api/identity/staff/members",
    pmsOperationsRequestOptions,
  );
  return response.members;
}

export async function updatePmsStaffStatus(
  membershipId: string,
  status: "active" | "deactivated",
): Promise<{ membershipId: string; status: "active" | "deactivated" }> {
  return pmsOperationsClient.patch<{
    membershipId: string;
    status: "active" | "deactivated";
  }>(
    `/api/identity/staff/members/${encodeURIComponent(membershipId)}/status`,
    { status },
    {
      ...pmsOperationsRequestOptions,
      headers: {
        ...(pmsOperationsRequestOptions.headers as Record<string, string>),
        "Idempotency-Key": `pms-staff-status:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`,
      },
    },
  );
}
