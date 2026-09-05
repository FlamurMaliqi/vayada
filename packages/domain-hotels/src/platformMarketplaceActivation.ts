import type { UpdateTracksResponse } from "./index.js";

export type PlatformMarketplaceAccount = {
  organizationId: string;
  displayName: string;
  properties: Array<{ propertyId: string; displayName: string }>;
  setup: UpdateTracksResponse;
};
export type PlatformMarketplaceAccountsResponse = {
  accounts: PlatformMarketplaceAccount[];
  canActivate: boolean;
};
