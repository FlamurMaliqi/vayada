import { vayadaApiClient } from "./client";

export const MARKETPLACE_TRIPS_CONTRACT_VERSION = "marketplace-trips-external.v1" as const;

export type MarketplaceTripsContractVersion = typeof MARKETPLACE_TRIPS_CONTRACT_VERSION;

export type MarketplaceTripsAuthorizationMode = "creator_workspace_resource_link";

export type MarketplaceExternalCollaborationType =
  | "custom_external"
  | "paid"
  | "free_stay"
  | "affiliate"
  | "other";

export type MarketplaceExternalCollaboration = {
  contractVersion: MarketplaceTripsContractVersion;
  authorizationMode: MarketplaceTripsAuthorizationMode;
  externalCollaborationId: string;
  creatorProfileId: string;
  organizationId: string;
  tripId: string | null;
  sourceExternalCollaborationId: string | null;
  title: string;
  hotelName: string | null;
  locationText: string | null;
  collaborationType: MarketplaceExternalCollaborationType | null;
  startDate: string;
  endDate: string;
  deliverablesSummary: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceTrip = {
  contractVersion: MarketplaceTripsContractVersion;
  authorizationMode: MarketplaceTripsAuthorizationMode;
  tripId: string;
  creatorProfileId: string;
  organizationId: string;
  sourceTripId: string | null;
  name: string;
  locationText: string | null;
  startDate: string;
  endDate: string;
  notes: string | null;
  externalCollaborations: MarketplaceExternalCollaboration[];
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceTripListResponse = {
  contractVersion: MarketplaceTripsContractVersion;
  authorizationMode: MarketplaceTripsAuthorizationMode;
  creatorProfileId: string;
  organizationId: string;
  items: MarketplaceTrip[];
};

export type MarketplaceExternalCollaborationListResponse = {
  contractVersion: MarketplaceTripsContractVersion;
  authorizationMode: MarketplaceTripsAuthorizationMode;
  creatorProfileId: string;
  organizationId: string;
  items: MarketplaceExternalCollaboration[];
};

export type CreateMarketplaceTripRequest = {
  idempotencyKey: string;
  name: string;
  locationText?: string | null;
  startDate: string;
  endDate: string;
  notes?: string | null;
};

export type UpdateMarketplaceTripRequest = Partial<
  Omit<CreateMarketplaceTripRequest, "idempotencyKey">
> & { idempotencyKey: string };

export type CreateMarketplaceExternalCollaborationRequest = {
  idempotencyKey: string;
  tripId?: string | null;
  title: string;
  hotelName?: string | null;
  locationText?: string | null;
  collaborationType?: MarketplaceExternalCollaborationType | null;
  startDate: string;
  endDate: string;
  deliverablesSummary?: string | null;
  notes?: string | null;
};

export type UpdateMarketplaceExternalCollaborationRequest = Partial<
  Omit<CreateMarketplaceExternalCollaborationRequest, "idempotencyKey">
> & {
  idempotencyKey: string;
};

export type MarketplaceTripWriteAction =
  | "trip.create"
  | "trip.update"
  | "trip.delete"
  | "external-collaboration.create"
  | "external-collaboration.update"
  | "external-collaboration.delete";

export const marketplaceTripEndpoints = {
  trips: () => "/api/marketplace/trips",
  trip: (tripId: string) => `/api/marketplace/trips/${encodeURIComponent(tripId)}`,
  externalCollaborations: () => "/api/marketplace/trips/external-collaborations",
  externalCollaboration: (externalCollaborationId: string) =>
    `/api/marketplace/trips/external-collaborations/${encodeURIComponent(externalCollaborationId)}`,
} as const;

export async function listMarketplaceTrips(): Promise<MarketplaceTripListResponse> {
  return vayadaApiClient.get<MarketplaceTripListResponse>(marketplaceTripEndpoints.trips());
}

export async function getMarketplaceTrip(tripId: string): Promise<MarketplaceTrip> {
  return vayadaApiClient.get<MarketplaceTrip>(marketplaceTripEndpoints.trip(tripId));
}

export async function createMarketplaceTrip(
  request: CreateMarketplaceTripRequest,
): Promise<MarketplaceTrip> {
  const { idempotencyKey, ...payload } = request;
  return vayadaApiClient.post<MarketplaceTrip>(
    marketplaceTripEndpoints.trips(),
    payload,
    toIdempotencyOptions(idempotencyKey),
  );
}

export async function updateMarketplaceTrip(
  tripId: string,
  request: UpdateMarketplaceTripRequest,
): Promise<MarketplaceTrip> {
  const { idempotencyKey, ...payload } = request;
  return vayadaApiClient.put<MarketplaceTrip>(
    marketplaceTripEndpoints.trip(tripId),
    payload,
    toIdempotencyOptions(idempotencyKey),
  );
}

export async function deleteMarketplaceTrip(tripId: string, idempotencyKey: string): Promise<void> {
  return vayadaApiClient.delete<void>(
    marketplaceTripEndpoints.trip(tripId),
    toIdempotencyOptions(idempotencyKey),
  );
}

export async function listMarketplaceExternalCollaborations(): Promise<MarketplaceExternalCollaborationListResponse> {
  return vayadaApiClient.get<MarketplaceExternalCollaborationListResponse>(
    marketplaceTripEndpoints.externalCollaborations(),
  );
}

export async function createMarketplaceExternalCollaboration(
  request: CreateMarketplaceExternalCollaborationRequest,
): Promise<MarketplaceExternalCollaboration> {
  const { idempotencyKey, ...payload } = request;
  return vayadaApiClient.post<MarketplaceExternalCollaboration>(
    marketplaceTripEndpoints.externalCollaborations(),
    payload,
    toIdempotencyOptions(idempotencyKey),
  );
}

export async function updateMarketplaceExternalCollaboration(
  externalCollaborationId: string,
  request: UpdateMarketplaceExternalCollaborationRequest,
): Promise<MarketplaceExternalCollaboration> {
  const { idempotencyKey, ...payload } = request;
  return vayadaApiClient.put<MarketplaceExternalCollaboration>(
    marketplaceTripEndpoints.externalCollaboration(externalCollaborationId),
    payload,
    toIdempotencyOptions(idempotencyKey),
  );
}

export async function deleteMarketplaceExternalCollaboration(
  externalCollaborationId: string,
  idempotencyKey: string,
): Promise<void> {
  return vayadaApiClient.delete<void>(
    marketplaceTripEndpoints.externalCollaboration(externalCollaborationId),
    toIdempotencyOptions(idempotencyKey),
  );
}

export function buildMarketplaceTripIdempotencyKey(input: {
  action: MarketplaceTripWriteAction;
  resourceId: string;
  nonce: string;
}): string {
  return `marketplace.${input.action}:${sanitizeIdempotencySegment(
    input.resourceId,
  )}:${sanitizeIdempotencySegment(input.nonce)}:v1`;
}

function toIdempotencyOptions(idempotencyKey: string): RequestInit {
  return { headers: { "Idempotency-Key": idempotencyKey } };
}

function sanitizeIdempotencySegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unknown"
  );
}
