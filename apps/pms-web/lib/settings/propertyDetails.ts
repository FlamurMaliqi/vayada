export type PmsPropertyProfileLoadStatus = "loading" | "ready" | "error";

export type PmsPropertyDetailsState = {
  loadStatus: PmsPropertyProfileLoadStatus;
  timezone: string;
  country: string;
};

export type PmsPropertyDetailsSaveError = "profile_not_ready" | "invalid_location";

export function pmsPropertyDetailsSaveError(
  state: PmsPropertyDetailsState,
): PmsPropertyDetailsSaveError | null {
  if (state.loadStatus !== "ready") {
    return "profile_not_ready";
  }
  if (!state.timezone.trim() || !/^[A-Za-z]{2}$/.test(state.country.trim())) {
    return "invalid_location";
  }
  return null;
}

export function canSavePmsPropertyDetails(state: PmsPropertyDetailsState): boolean {
  return pmsPropertyDetailsSaveError(state) === null;
}
