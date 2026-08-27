import { ApiClient, omitHotelContext } from "./client";

export function isPmsOperationsReadModelEnabled(): boolean {
  return true;
}

const PMS_OPERATIONS_API_URL =
  process.env.NEXT_PUBLIC_PMS_OPERATIONS_API_URL ||
  process.env.NEXT_PUBLIC_VAYADA_API_URL ||
  "https://api.localhost";

export const pmsOperationsClient = new ApiClient(PMS_OPERATIONS_API_URL);
export const pmsOperationsRequestOptions: RequestInit = {
  ...omitHotelContext,
  cache: "no-store",
};

export function assertPmsOperationsReadModelEnabled(): void {}
