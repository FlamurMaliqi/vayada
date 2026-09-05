"use client";

import { useState, useEffect, useCallback } from "react";
import { AuthenticatedNavigation } from "@/components/layout";
import { useSidebar } from "@/components/layout/AuthenticatedNavigation";
import { YearlyCalendar } from "@/components/calendar/YearlyCalendar";
import {
  collaborationService,
  transformCollaborationResponse,
  type CollaborationResponse,
} from "@/services/api/collaborations";
import {
  tripService,
  type TripResponse,
  type ExternalCollaborationResponse,
} from "@/services/api/trips";
import { CollaborationRequestDetailModal } from "@/components/marketplace/CollaborationRequestDetailModal";
import type { Collaboration, Hotel, Creator } from "@/lib/types";
import { STORAGE_KEYS } from "@/lib/constants";

function CalendarPageContent() {
  const { isCollapsed } = useSidebar();
  const [collaborations, setCollaborations] = useState<CollaborationResponse[]>([]);
  const [trips, setTrips] = useState<TripResponse[]>([]);
  const [externalCollaborations, setExternalCollaborations] = useState<
    ExternalCollaborationResponse[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [detailCollaboration, setDetailCollaboration] = useState<
    (Collaboration & { hotel?: Hotel; creator?: Creator }) | null
  >(null);
  const [userType, setUserType] = useState<"hotel" | "creator">("hotel");

  const fetchData = useCallback(async (storedUserType: "hotel" | "creator") => {
    try {
      let collabData: CollaborationResponse[] = [];
      if (storedUserType === "creator") {
        const [collabs, tripsData, extCollabs] = await Promise.all([
          collaborationService.getCreatorCollaborations(),
          tripService.listTrips(),
          tripService.listExternalCollaborations(),
        ]);
        collabData = collabs;
        setTrips(tripsData);
        setExternalCollaborations(extCollabs);
      } else {
        collabData = await collaborationService.getHotelCollaborations();
      }
      setCollaborations(collabData);
    } catch (error) {
      console.error("Failed to fetch calendar data:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const storedUserType = localStorage.getItem(STORAGE_KEYS.USER_TYPE) as "hotel" | "creator";
    if (storedUserType) {
      setUserType(storedUserType);
    }
    fetchData(storedUserType || "hotel");
  }, [fetchData]);

  const handleDataChanged = () => {
    fetchData(userType);
  };

  const handleViewDetails = async (id: string) => {
    try {
      const detailResponse =
        userType === "creator"
          ? await collaborationService.getCreatorCollaborationDetails(id)
          : await collaborationService.getHotelCollaborationDetails(id);
      const detailedCollaboration = transformCollaborationResponse(detailResponse);
      setDetailCollaboration(detailedCollaboration);
    } catch (error) {
      console.error("Error fetching collaboration details:", error);
    }
  };

  const handleAccept = async (id: string) => {
    try {
      await collaborationService.respondToCollaboration(id, {
        status: "accepted",
        expectedUpdatedAt: detailCollaboration?.updatedAt.toISOString(),
      });
      handleViewDetails(id);
    } catch (error) {
      await handleViewDetails(id);
      window.alert(error instanceof Error ? error.message : "Could not accept request.");
    }
  };

  const handleDecline = async (id: string) => {
    try {
      await collaborationService.respondToCollaboration(id, {
        status: "declined",
        expectedUpdatedAt: detailCollaboration?.updatedAt.toISOString(),
      });
      handleViewDetails(id);
    } catch (error) {
      await handleViewDetails(id);
      window.alert(error instanceof Error ? error.message : "Could not decline request.");
    }
  };

  const handleApprove = async (id: string) => {
    try {
      await collaborationService.approveCollaboration(id);
      handleViewDetails(id);
    } catch (error) {
      console.error("Failed to approve collaboration:", error);
    }
  };

  return (
    <main className="min-h-screen bg-gray-50">
      <AuthenticatedNavigation />
      <div className={`pt-12 transition-all duration-200 ${isCollapsed ? "md:pl-14" : "md:pl-52"}`}>
        <div className="w-full px-4 py-4 md:px-6 md:py-6">
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Collaboration planning
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-normal text-gray-950 md:text-3xl">
              Calendar
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Track stays, campaign windows, trips, and external creator commitments.
            </p>
          </div>
          {isLoading ? (
            <div className="grid h-[600px] place-items-center rounded-lg border border-gray-200 bg-white shadow-sm">
              <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary-600"></div>
            </div>
          ) : (
            <YearlyCalendar
              collaborations={collaborations}
              trips={trips}
              externalCollaborations={externalCollaborations}
              onViewDetails={handleViewDetails}
              onDataChanged={handleDataChanged}
              userType={userType}
            />
          )}
        </div>
      </div>

      <CollaborationRequestDetailModal
        isOpen={!!detailCollaboration}
        onClose={() => setDetailCollaboration(null)}
        collaboration={detailCollaboration}
        currentUserType={userType}
        onUpdated={(value) => {
          setDetailCollaboration(value);
          handleDataChanged();
        }}
        onAccept={handleAccept}
        onDecline={handleDecline}
        onApprove={handleApprove}
      />
    </main>
  );
}

export default function CalendarPage() {
  return <CalendarPageContent />;
}
