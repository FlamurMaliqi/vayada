import { apiClient } from "./client";
import type {
  PlatformPropertyLifecycleResult,
  PlatformPropertyLifecycleStatus,
  PlatformPropertyProvisionRequest,
  PlatformPropertyRetirementImpact,
  PlatformPropertyStatusCommand,
} from "@vayada/domain-hotels";

export type PlatformStatus = "live" | "demo" | "test";
export type Granularity = "daily" | "weekly" | "monthly";

export interface PlatformProperty {
  id: string;
  name: string;
  slug: string;
  status: PlatformStatus;
  lifecycleStatus: PlatformPropertyLifecycleStatus;
  lifecycleRevision: number;
  ownerAccountUserIds: string[];
  createdAt: string;
}

export interface GrowthMetric {
  key: string;
  label: string;
  value: string;
  rawValue: number | null;
  delta: { value: number | null; label: string } | null;
}

export interface ChartPoint {
  key: string;
  label: string;
  value: number;
}

export interface GrowthDashboard {
  properties: PlatformProperty[];
  selectedPropertyIds: string[];
  excludeTestData: boolean;
  granularity: Granularity;
  bookingPropertyId: string | null;
  metrics: GrowthMetric[];
  pageViews: ChartPoint[];
  bookingRequests: ChartPoint[];
  liveProperties: ChartPoint[];
  emptyMessage: string | null;
}

export function getGrowthDashboard(params: {
  granularity: Granularity;
  excludeTestData: boolean;
  propertyIds?: string[];
  bookingPropertyId?: string;
}) {
  const search = new URLSearchParams({
    granularity: params.granularity,
    exclude_test_data: String(params.excludeTestData),
  });

  if (params.propertyIds) {
    if (params.propertyIds.length === 0) {
      search.append("property_ids", "");
    } else {
      params.propertyIds.forEach((id) => search.append("property_ids", id));
    }
  }

  if (params.bookingPropertyId) {
    search.set("booking_property_id", params.bookingPropertyId);
  }

  return apiClient.get<GrowthDashboard>(`/api/platform/admin/growth?${search.toString()}`);
}

export function getPropertyRetirementImpact(id: string) {
  return apiClient.get<PlatformPropertyRetirementImpact>(
    `/api/platform/admin/properties/${id}/retirement-impact`,
  );
}

export function updatePropertyStatus(id: string, input: PlatformPropertyStatusCommand) {
  return apiClient.patch<PlatformPropertyLifecycleResult>(
    `/api/platform/admin/properties/${id}/status`,
    input,
    idempotencyOptions(),
  );
}

export function retireProperty(
  id: string,
  input: { expectedLifecycleRevision: number; reason: string },
) {
  return apiClient.post<PlatformPropertyLifecycleResult>(
    `/api/platform/admin/properties/${id}/retire`,
    { ...input, confirmation: "RETIRE" },
    idempotencyOptions(),
  );
}

export function provisionProperty(input: PlatformPropertyProvisionRequest) {
  return apiClient.post<PlatformPropertyLifecycleResult>(
    "/api/platform/admin/properties/provision",
    input,
    idempotencyOptions(),
  );
}

function idempotencyOptions(): RequestInit {
  return { headers: { "Idempotency-Key": crypto.randomUUID() } };
}

export type {
  PlatformPropertyLifecycleResult,
  PlatformPropertyLifecycleStatus,
  PlatformPropertyProvisionRequest,
  PlatformPropertyRetirementImpact,
  PlatformPropertyStatusCommand,
};
