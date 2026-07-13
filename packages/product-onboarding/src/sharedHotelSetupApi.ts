import type {
  SharedHotelSetupAccountProductSelection,
  SharedHotelSetupEntryProduct,
  SharedHotelSetupProduct,
  SharedHotelSetupStatus,
  SharedPropertyProfile,
  SharedPropertyProfileInput,
} from "./sharedFirstRunSetupFlow";

export type SharedHotelSetupHttpClient = {
  get<T>(endpoint: string, options?: RequestInit): Promise<T>;
  post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
  put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

export type SharedHotelSetupStatusParams = {
  entryProduct?: SharedHotelSetupEntryProduct | null;
  returnTo?: string | null;
  propertyId?: string | null;
};

export type SharedHotelSetupApi = {
  getStatus(params?: SharedHotelSetupStatusParams): Promise<SharedHotelSetupStatus>;
  getPropertyProfile(propertyId: string): Promise<SharedPropertyProfile>;
  createPropertyProfile(profile: SharedPropertyProfileInput): Promise<SharedPropertyProfile>;
  updatePropertyProfile(
    propertyId: string,
    profile: SharedPropertyProfileInput,
  ): Promise<SharedPropertyProfile>;
  saveAccountProductSelection(
    selectedProducts: SharedHotelSetupProduct[],
  ): Promise<SharedHotelSetupAccountProductSelection>;
};

export function createSharedHotelSetupApi(client: SharedHotelSetupHttpClient): SharedHotelSetupApi {
  return {
    getStatus: (params) => client.get<SharedHotelSetupStatus>(statusEndpoint(params)),
    getPropertyProfile: (propertyId) =>
      client.get<SharedPropertyProfile>(
        `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/profile`,
      ),
    createPropertyProfile: (profile) =>
      client.post<SharedPropertyProfile>("/api/hotel-setup/properties", profile),
    updatePropertyProfile: (propertyId, profile) =>
      client.put<SharedPropertyProfile>(
        `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/profile`,
        profile,
      ),
    saveAccountProductSelection: (selectedProducts) =>
      client.put<SharedHotelSetupAccountProductSelection>("/api/hotel-setup/products", {
        selectedProducts,
      }),
  };
}

function statusEndpoint(params: SharedHotelSetupStatusParams = {}): string {
  const query = new URLSearchParams();
  if (params.entryProduct) query.set("entryProduct", params.entryProduct);
  if (params.returnTo) query.set("returnTo", params.returnTo);
  if (params.propertyId) query.set("propertyId", params.propertyId);
  const suffix = query.toString();
  return suffix ? `/api/hotel-setup/status?${suffix}` : "/api/hotel-setup/status";
}
