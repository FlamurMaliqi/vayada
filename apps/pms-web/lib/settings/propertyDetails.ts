export type PmsPropertyProfileLoadStatus = "loading" | "ready" | "error";

export type PmsPropertyDetailsState = {
  loadStatus: PmsPropertyProfileLoadStatus;
  timezone: string;
  country: string;
};

export function pmsPropertyDetailsSaveError(state: PmsPropertyDetailsState): string | null {
  if (state.loadStatus !== "ready") {
    return "Load the canonical property profile before saving.";
  }
  if (!state.timezone.trim() || !/^[A-Za-z]{2}$/.test(state.country.trim())) {
    return "Select a timezone and enter a two-letter ISO country code before saving.";
  }
  return null;
}

export function canSavePmsPropertyDetails(state: PmsPropertyDetailsState): boolean {
  return pmsPropertyDetailsSaveError(state) === null;
}
