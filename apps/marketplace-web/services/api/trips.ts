/**
 * Trip and External Collaboration API service
 */
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
  collaboration_type: ExternalCollaborationType | null;
  start_date: string;
  end_date: string;
  deliverables: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type ExternalCollaborationType =
  | "Custom / External"
  | "Paid"
  | "Free Stay"
  | "Affiliate"
  | "Other";

export interface CreateTripRequest {
  idempotency_key?: string;
  name: string;
  location?: string;
  start_date: string;
  end_date: string;
  notes?: string;
}

export interface UpdateTripRequest {
  name?: string;
  location?: string | null;
  start_date?: string;
  end_date?: string;
  notes?: string | null;
}

export interface CreateExternalCollaborationRequest {
  idempotency_key?: string;
  trip_id?: string;
  title: string;
  hotel_name?: string;
  location?: string;
  collaboration_type?: ExternalCollaborationType;
  start_date: string;
  end_date: string;
  deliverables?: string;
  notes?: string;
}

export interface UpdateExternalCollaborationRequest {
  trip_id?: string | null;
  title?: string;
  hotel_name?: string | null;
  location?: string | null;
  collaboration_type?: ExternalCollaborationType | null;
  start_date?: string;
  end_date?: string;
  deliverables?: string | null;
  notes?: string | null;
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
    const pending = resolvePendingCreate(
      "trip",
      tripCreateFingerprint(data),
      data.idempotency_key ?? options.idempotencyKey,
    );
    const created = toLegacyTripResponse(
      await createMarketplaceTrip({
        idempotencyKey: pending.idempotencyKey,
        name: data.name,
        locationText: data.location,
        startDate: data.start_date,
        endDate: data.end_date,
        notes: data.notes,
      }),
    );
    pending.complete();
    return created;
  },

  /**
   * List all trips for the current creator
   */
  listTrips: async (): Promise<TripResponse[]> => {
    const response = await listMarketplaceTrips();
    return response.items.map(toLegacyTripResponse);
  },

  /**
   * Get a trip by ID
   */
  getTrip: async (tripId: string): Promise<TripResponse> => {
    return toLegacyTripResponse(await getMarketplaceTrip(tripId));
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
  },

  /**
   * Delete a trip
   */
  deleteTrip: async (tripId: string, options: TripWriteOptions = {}): Promise<void> => {
    const idempotencyKey = resolveTripWriteIdempotencyKey("trip.delete", tripId, options);
    return deleteMarketplaceTrip(tripId, idempotencyKey);
  },

  /**
   * Create an external collaboration
   */
  createExternalCollaboration: async (
    data: CreateExternalCollaborationRequest,
    options: TripWriteOptions = {},
  ): Promise<ExternalCollaborationResponse> => {
    const pending = resolvePendingCreate(
      "external-collaboration",
      externalCollaborationCreateFingerprint(data),
      data.idempotency_key ?? options.idempotencyKey,
    );
    const created = toLegacyExternalCollaborationResponse(
      await createMarketplaceExternalCollaboration({
        idempotencyKey: pending.idempotencyKey,
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
    pending.complete();
    return created;
  },

  /**
   * List all external collaborations for the current creator
   */
  listExternalCollaborations: async (): Promise<ExternalCollaborationResponse[]> => {
    const response = await listMarketplaceExternalCollaborations();
    return response.items.map(toLegacyExternalCollaborationResponse);
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
    return deleteMarketplaceExternalCollaboration(collabId, idempotencyKey);
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
  value?:
    | CreateExternalCollaborationRequest["collaboration_type"]
    | UpdateExternalCollaborationRequest["collaboration_type"],
): MarketplaceExternalCollaborationType | null | undefined {
  if (value === undefined) return undefined;
  switch (value) {
    case "Custom / External":
      return "custom_external";
    case "Paid":
      return "paid";
    case "Free Stay":
      return "free_stay";
    case "Affiliate":
      return "affiliate";
    case "Other":
      return "other";
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

const pendingCreateKeys = new Map<string, string>();

function resolvePendingCreate(
  resource: "trip" | "external-collaboration",
  fingerprint: string,
  explicitKey?: string,
): { idempotencyKey: string; complete: () => void } {
  const provided = explicitKey?.trim();
  if (provided) {
    return { idempotencyKey: provided, complete: () => undefined };
  }

  const operation = `marketplace.${resource}.create`;
  const pendingKey = `${operation}:${fingerprint}`;
  const action: MarketplaceTripWriteAction =
    resource === "trip" ? "trip.create" : "external-collaboration.create";
  const idempotencyKey =
    pendingCreateKeys.get(pendingKey) ?? createTripWriteIdempotencyKey(action, "new");
  pendingCreateKeys.set(pendingKey, idempotencyKey);
  return {
    idempotencyKey,
    complete: () => {
      if (pendingCreateKeys.get(pendingKey) === idempotencyKey)
        pendingCreateKeys.delete(pendingKey);
    },
  };
}

function tripCreateFingerprint(data: CreateTripRequest): string {
  return JSON.stringify({
    name: data.name.trim(),
    location: data.location?.trim() || null,
    startDate: data.start_date,
    endDate: data.end_date,
    notes: data.notes?.trim() || null,
  });
}

function externalCollaborationCreateFingerprint(data: CreateExternalCollaborationRequest): string {
  return JSON.stringify({
    tripId: data.trip_id || null,
    title: data.title.trim(),
    hotelName: data.hotel_name?.trim() || null,
    location: data.location?.trim() || null,
    collaborationType: data.collaboration_type || null,
    startDate: data.start_date,
    endDate: data.end_date,
    deliverables: data.deliverables?.trim() || null,
    notes: data.notes?.trim() || null,
  });
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
