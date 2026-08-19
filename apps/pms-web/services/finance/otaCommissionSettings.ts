import {
  pmsOperationsClient,
  pmsOperationsRequestOptions,
} from "@/services/api/pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";

export const OTA_COMMISSION_CHANNELS = [
  ["booking_com", "Booking.com"],
  ["airbnb", "Airbnb"],
  ["expedia", "Expedia"],
  ["agoda", "Agoda"],
  ["other_ota", "Other OTA"],
] as const;
export type OtaCommissionChannel = (typeof OTA_COMMISSION_CHANNELS)[number][0];
export type OtaCommissionSetting =
  | { channel: OtaCommissionChannel; status: "unconfigured"; reason: "not_configured" }
  | {
      channel: OtaCommissionChannel;
      status: "configured";
      ruleId: string;
      percentageRate: string;
      effectiveFrom: string;
      effectiveTo: string | null;
      revision: number;
    };
type ConfiguredSetting = Extract<OtaCommissionSetting, { status: "configured" }>;
const pendingCommands = new Map<string, string>();
function endpoint(propertyId: string, channel?: OtaCommissionChannel): string {
  const base = `/api/finance/properties/${encodeURIComponent(propertyId)}/financials/ota-commission-settings`;
  return channel ? `${base}/${channel}` : base;
}
export async function listOtaCommissionSettings(): Promise<OtaCommissionSetting[]> {
  const propertyId = await resolveSelectedPmsPropertyId("loading OTA commission settings");
  const response = await pmsOperationsClient.get<{ settings: OtaCommissionSetting[] }>(
    endpoint(propertyId),
    pmsOperationsRequestOptions,
  );
  return response.settings;
}
export async function updateOtaCommissionSetting(
  channel: OtaCommissionChannel,
  input: { percentageRate: string; effectiveFrom: string; expectedRevision: number },
): Promise<ConfiguredSetting> {
  const propertyId = await resolveSelectedPmsPropertyId("saving OTA commission settings");
  const fingerprint = JSON.stringify([propertyId, channel, input]);
  const commandId =
    pendingCommands.get(fingerprint) ??
    `pms-ota-commission:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
  pendingCommands.set(fingerprint, commandId);
  const response = await pmsOperationsClient.put<{ setting: ConfiguredSetting }>(
    endpoint(propertyId, channel),
    { commandId, idempotencyKey: commandId, ...input },
    pmsOperationsRequestOptions,
  );
  pendingCommands.delete(fingerprint);
  return response.setting;
}
