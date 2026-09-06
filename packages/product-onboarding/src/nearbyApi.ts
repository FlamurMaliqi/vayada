import {
  parseNearbyCurationState,
  parseNearbyCurationWrite,
  parseNearbyDiscoveryState,
  type NearbyCurationWrite,
} from "@vayada/domain-hotels";
import type { SharedHotelSetupHttpClient } from "./sharedHotelSetupApi";

export function createNearbyApi(client: SharedHotelSetupHttpClient) {
  const path = (id: string) => `/api/hotel-setup/properties/${encodeURIComponent(id)}/nearby`;
  return {
    read: async (id: string, options?: RequestInit) =>
      parseNearbyCurationState(await client.get(`${path(id)}/curation`, options)),
    discovery: async (id: string, options?: RequestInit) =>
      parseNearbyDiscoveryState(await client.get(path(id), options)),
    refresh: async (id: string, expectedProfileRevision: number, force = false) =>
      parseNearbyDiscoveryState(
        await client.post(`${path(id)}/refresh`, { expectedProfileRevision, force }),
      ),
    save: async (id: string, write: NearbyCurationWrite) => {
      const parsed = parseNearbyCurationWrite(write);
      if (!parsed.ok)
        throw new Error("Check the place names, coordinates and notes before saving.");
      return parseNearbyCurationState(await client.put(`${path(id)}/curation`, parsed.value));
    },
  };
}
export type NearbyApi = ReturnType<typeof createNearbyApi>;
