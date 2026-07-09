import { AdminCollaborationsResponse, Collaboration } from "@/lib/types/collaboration";
import { apiClient } from "./client";

export const collaborationsService = {
  /**
   * Fetch admin collaborations with pagination, filtering, and search.
   */
  getCollaborations: async (
    page: number = 1,
    pageSize: number = 20,
    filters?: { status?: string; search?: string },
  ): Promise<AdminCollaborationsResponse> => {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
    });
    if (filters?.status && filters.status !== "all") params.set("status", filters.status);
    if (filters?.search) params.set("search", filters.search);
    return apiClient.get<AdminCollaborationsResponse>(`/admin/collaborations?${params}`);
  },

  /**
   * Accept or decline a pending collaboration on behalf of the hotel.
   */
  respondAsHotel: async (
    collaborationId: string,
    status: "accepted" | "declined",
    responseMessage?: string,
  ): Promise<Collaboration> => {
    return apiClient.post<Collaboration>(`/admin/collaborations/${collaborationId}/respond`, {
      status,
      response_message: responseMessage,
    });
  },

  /**
   * Approve current terms on behalf of the hotel. Finalizes the collaboration
   * when the creator has already approved.
   */
  approveAsHotel: async (collaborationId: string): Promise<Collaboration> => {
    return apiClient.post<Collaboration>(`/admin/collaborations/${collaborationId}/approve`, {});
  },
};
