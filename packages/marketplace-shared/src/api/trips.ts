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
  name: string;
  locationText?: string | null;
  startDate: string;
  endDate: string;
  notes?: string | null;
};

export type UpdateMarketplaceTripRequest = Partial<CreateMarketplaceTripRequest>;

export type CreateMarketplaceExternalCollaborationRequest = {
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

export type UpdateMarketplaceExternalCollaborationRequest =
  Partial<CreateMarketplaceExternalCollaborationRequest>;

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
  return vayadaApiClient.post<MarketplaceTrip>(marketplaceTripEndpoints.trips(), request);
}

export async function updateMarketplaceTrip(
  tripId: string,
  request: UpdateMarketplaceTripRequest,
): Promise<MarketplaceTrip> {
  return vayadaApiClient.put<MarketplaceTrip>(marketplaceTripEndpoints.trip(tripId), request);
}

export async function deleteMarketplaceTrip(tripId: string): Promise<void> {
  return vayadaApiClient.delete<void>(marketplaceTripEndpoints.trip(tripId));
}

export async function listMarketplaceExternalCollaborations(): Promise<MarketplaceExternalCollaborationListResponse> {
  return vayadaApiClient.get<MarketplaceExternalCollaborationListResponse>(
    marketplaceTripEndpoints.externalCollaborations(),
  );
}

export async function createMarketplaceExternalCollaboration(
  request: CreateMarketplaceExternalCollaborationRequest,
): Promise<MarketplaceExternalCollaboration> {
  return vayadaApiClient.post<MarketplaceExternalCollaboration>(
    marketplaceTripEndpoints.externalCollaborations(),
    request,
  );
}

export async function updateMarketplaceExternalCollaboration(
  externalCollaborationId: string,
  request: UpdateMarketplaceExternalCollaborationRequest,
): Promise<MarketplaceExternalCollaboration> {
  return vayadaApiClient.put<MarketplaceExternalCollaboration>(
    marketplaceTripEndpoints.externalCollaboration(externalCollaborationId),
    request,
  );
}

export async function deleteMarketplaceExternalCollaboration(
  externalCollaborationId: string,
): Promise<void> {
  return vayadaApiClient.delete<void>(
    marketplaceTripEndpoints.externalCollaboration(externalCollaborationId),
  );
}
