/**
 * Trip and External Collaboration API service
 */
import { apiClient } from "./client";
import {
  buildMarketplaceTripIdempotencyKey,
  createMarketplaceExternalCollaboration,
  createMarketplaceTrip,
  deleteMarketplaceExternalCollaboration,
  deleteMarketplaceTrip,
  getMarketplaceTrip,
  listMarketplaceExternalCollaborations,
  listMarketplaceTrips,
  updateMarketplaceExternalCollaboration,
  updateMarketplaceTrip,
  type MarketplaceExternalCollaboration,
  type MarketplaceExternalCollaborationType,
  type MarketplaceTrip,
  type MarketplaceTripWriteAction,
} from "@vayada/marketplace-shared/api/trips";

export interface TripResponse {
  id: string;
  creator_id: string;
  name: string;
  location: string | null;
  start_date: string;
  end_date: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  external_collaborations: ExternalCollaborationResponse[];
}

export interface ExternalCollaborationResponse {
  id: string;
  creator_id: string;
  trip_id: string | null;
  title: string;
  hotel_name: string | null;
  location: string | null;
  collaboration_type: string | null;
  start_date: string;
  end_date: string;
  deliverables: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTripRequest {
  name: string;
  location?: string;
  start_date: string;
  end_date: string;
  notes?: string;
}

export interface UpdateTripRequest {
  name?: string;
  location?: string;
  start_date?: string;
  end_date?: string;
  notes?: string;
}

export interface CreateExternalCollaborationRequest {
  trip_id?: string;
  title: string;
  hotel_name?: string;
  location?: string;
  collaboration_type?: "Custom / External" | "Paid" | "Free Stay";
  start_date: string;
  end_date: string;
  deliverables?: string;
  notes?: string;
}

export interface UpdateExternalCollaborationRequest {
  trip_id?: string;
  title?: string;
  hotel_name?: string;
  location?: string;
  collaboration_type?: "Custom / External" | "Paid" | "Free Stay";
  start_date?: string;
  end_date?: string;
  deliverables?: string;
  notes?: string;
}

export interface TripWriteOptions {
  idempotencyKey?: string;
}

export const tripService = {
  /**
   * Create a new trip
   */
  createTrip: async (
    data: CreateTripRequest,
    options: TripWriteOptions = {},
  ): Promise<TripResponse> => {
    const idempotencyKey = resolveTripWriteIdempotencyKey("trip.create", "new", options);
    try {
      return toLegacyTripResponse(
        await createMarketplaceTrip({
          idempotencyKey,
          name: data.name,
          locationText: data.location,
          startDate: data.start_date,
          endDate: data.end_date,
          notes: data.notes,
        }),
      );
    } catch (error) {
      if (!isMissingMarketplaceTripRoute(error)) throw error;
      return apiClient.post<TripResponse>(
        "/trips",
        data,
        toLegacyIdempotencyOptions(idempotencyKey),
      );
    }
  },

  /**
   * List all trips for the current creator
   */
  listTrips: async (): Promise<TripResponse[]> => {
    try {
      const response = await listMarketplaceTrips();
      return response.items.map(toLegacyTripResponse);
    } catch (error) {
      if (!isMissingMarketplaceTripRoute(error)) throw error;
      return apiClient.get<TripResponse[]>("/trips");
    }
  },

  /**
   * Get a trip by ID
   */
  getTrip: async (tripId: string): Promise<TripResponse> => {
    try {
      return toLegacyTripResponse(await getMarketplaceTrip(tripId));
    } catch (error) {
      if (!isMissingMarketplaceTripRoute(error)) throw error;
      return apiClient.get<TripResponse>(`/trips/${tripId}`);
    }
  },

  /**
   * Update a trip
   */
  updateTrip: async (
    tripId: string,
    data: UpdateTripRequest,
    options: TripWriteOptions = {},
  ): Promise<TripResponse> => {
    const idempotencyKey = resolveTripWriteIdempotencyKey("trip.update", tripId, options);
    try {
      return toLegacyTripResponse(
        await updateMarketplaceTrip(tripId, {
          idempotencyKey,
          name: data.name,
          locationText: data.location,
          startDate: data.start_date,
          endDate: data.end_date,
          notes: data.notes,
        }),
      );
    } catch (error) {
      if (!isMissingMarketplaceTripRoute(error)) throw error;
      return apiClient.put<TripResponse>(
        `/trips/${tripId}`,
        data,
        toLegacyIdempotencyOptions(idempotencyKey),
      );
    }
  },

  /**
   * Delete a trip
   */
  deleteTrip: async (tripId: string, options: TripWriteOptions = {}): Promise<void> => {
    const idempotencyKey = resolveTripWriteIdempotencyKey("trip.delete", tripId, options);
    try {
      return await deleteMarketplaceTrip(tripId, idempotencyKey);
    } catch (error) {
      if (!isMissingMarketplaceTripRoute(error)) throw error;
      return apiClient.delete<void>(`/trips/${tripId}`, toLegacyIdempotencyOptions(idempotencyKey));
    }
  },

  /**
   * Create an external collaboration
   */
  createExternalCollaboration: async (
    data: CreateExternalCollaborationRequest,
    options: TripWriteOptions = {},
  ): Promise<ExternalCollaborationResponse> => {
    const idempotencyKey = resolveTripWriteIdempotencyKey(
      "external-collaboration.create",
      "new",
      options,
    );
    try {
      return toLegacyExternalCollaborationResponse(
        await createMarketplaceExternalCollaboration({
          idempotencyKey,
          tripId: data.trip_id,
          title: data.title,
          hotelName: data.hotel_name,
          locationText: data.location,
          collaborationType: toTargetExternalCollaborationType(data.collaboration_type),
          startDate: data.start_date,
          endDate: data.end_date,
          deliverablesSummary: data.deliverables,
          notes: data.notes,
        }),
      );
    } catch (error) {
      if (!isMissingMarketplaceTripRoute(error)) throw error;
      return apiClient.post<ExternalCollaborationResponse>(
        "/trips/external-collaborations",
        data,
        toLegacyIdempotencyOptions(idempotencyKey),
      );
    }
  },

  /**
   * List all external collaborations for the current creator
   */
  listExternalCollaborations: async (): Promise<ExternalCollaborationResponse[]> => {
    try {
      const response = await listMarketplaceExternalCollaborations();
      return response.items.map(toLegacyExternalCollaborationResponse);
    } catch (error) {
      if (!isMissingMarketplaceTripRoute(error)) throw error;
      return apiClient.get<ExternalCollaborationResponse[]>("/trips/external-collaborations");
    }
  },

  /**
   * Update an external collaboration
   */
  updateExternalCollaboration: async (
    collabId: string,
    data: UpdateExternalCollaborationRequest,
    options: TripWriteOptions = {},
  ): Promise<ExternalCollaborationResponse> => {
    const idempotencyKey = resolveTripWriteIdempotencyKey(
      "external-collaboration.update",
      collabId,
      options,
    );
    try {
      return toLegacyExternalCollaborationResponse(
        await updateMarketplaceExternalCollaboration(collabId, {
          idempotencyKey,
          tripId: data.trip_id,
          title: data.title,
          hotelName: data.hotel_name,
          locationText: data.location,
          collaborationType: toTargetExternalCollaborationType(data.collaboration_type),
          startDate: data.start_date,
          endDate: data.end_date,
          deliverablesSummary: data.deliverables,
          notes: data.notes,
        }),
      );
    } catch (error) {
      if (!isMissingMarketplaceTripRoute(error)) throw error;
      return apiClient.put<ExternalCollaborationResponse>(
        `/trips/external-collaborations/${collabId}`,
        data,
        toLegacyIdempotencyOptions(idempotencyKey),
      );
    }
  },

  /**
   * Delete an external collaboration
   */
  deleteExternalCollaboration: async (
    collabId: string,
    options: TripWriteOptions = {},
  ): Promise<void> => {
    const idempotencyKey = resolveTripWriteIdempotencyKey(
      "external-collaboration.delete",
      collabId,
      options,
    );
    try {
      return await deleteMarketplaceExternalCollaboration(collabId, idempotencyKey);
    } catch (error) {
      if (!isMissingMarketplaceTripRoute(error)) throw error;
      return apiClient.delete<void>(
        `/trips/external-collaborations/${collabId}`,
        toLegacyIdempotencyOptions(idempotencyKey),
      );
    }
  },
};

function toLegacyTripResponse(trip: MarketplaceTrip): TripResponse {
  return {
    id: trip.tripId,
    creator_id: trip.creatorProfileId,
    name: trip.name,
    location: trip.locationText,
    start_date: trip.startDate,
    end_date: trip.endDate,
    notes: trip.notes,
    created_at: trip.createdAt,
    updated_at: trip.updatedAt,
    external_collaborations: trip.externalCollaborations.map(toLegacyExternalCollaborationResponse),
  };
}

function toLegacyExternalCollaborationResponse(
  collaboration: MarketplaceExternalCollaboration,
): ExternalCollaborationResponse {
  return {
    id: collaboration.externalCollaborationId,
    creator_id: collaboration.creatorProfileId,
    trip_id: collaboration.tripId,
    title: collaboration.title,
    hotel_name: collaboration.hotelName,
    location: collaboration.locationText,
    collaboration_type: toLegacyExternalCollaborationType(collaboration.collaborationType),
    start_date: collaboration.startDate,
    end_date: collaboration.endDate,
    deliverables: collaboration.deliverablesSummary,
    notes: collaboration.notes,
    created_at: collaboration.createdAt,
    updated_at: collaboration.updatedAt,
  };
}

function toTargetExternalCollaborationType(
  value?: CreateExternalCollaborationRequest["collaboration_type"],
): MarketplaceExternalCollaborationType | null | undefined {
  if (value === undefined) return undefined;
  switch (value) {
    case "Custom / External":
      return "custom_external";
    case "Paid":
      return "paid";
    case "Free Stay":
      return "free_stay";
    default:
      return null;
  }
}

function toLegacyExternalCollaborationType(
  value: MarketplaceExternalCollaborationType | null,
): ExternalCollaborationResponse["collaboration_type"] {
  switch (value) {
    case "custom_external":
      return "Custom / External";
    case "paid":
      return "Paid";
    case "free_stay":
      return "Free Stay";
    case "affiliate":
      return "Affiliate";
    case "other":
      return "Other";
    default:
      return null;
  }
}

function isMissingMarketplaceTripRoute(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  if ((error as { status: unknown }).status !== 404) return false;

  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  if ("code" in data) return false;

  const detail = (data as { detail?: unknown }).detail;
  if (detail === "Not Found") return true;

  const fastifyError = data as { error?: unknown; message?: unknown };
  return (
    fastifyError.error === "Not Found" &&
    typeof fastifyError.message === "string" &&
    fastifyError.message.startsWith("Route ") &&
    fastifyError.message.includes("/api/marketplace/trips")
  );
}

function resolveTripWriteIdempotencyKey(
  action: MarketplaceTripWriteAction,
  resourceId: string,
  options: TripWriteOptions,
): string {
  const provided = options.idempotencyKey?.trim();
  if (provided) return provided;
  return createTripWriteIdempotencyKey(action, resourceId);
}

export function createTripWriteIdempotencyKey(
  action: MarketplaceTripWriteAction,
  resourceId: string,
): string {
  const nonce =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return buildMarketplaceTripIdempotencyKey({ action, resourceId, nonce });
}

function toLegacyIdempotencyOptions(idempotencyKey: string): RequestInit {
  return { headers: { "Idempotency-Key": idempotencyKey } };
}
