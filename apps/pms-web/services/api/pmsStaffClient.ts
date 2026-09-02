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
