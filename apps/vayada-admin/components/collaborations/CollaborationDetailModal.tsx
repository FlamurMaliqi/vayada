"use client";

import { useState } from "react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Avatar } from "../ui/Avatar";
import { Textarea } from "../ui/Textarea";
import { Collaboration, CollaborationStatus } from "../../lib/types/collaboration";
import { getCurrencySymbol } from "../../lib/utils/getCurrencySymbol";
import { collaborationsService } from "../../services/api";
import { ApiErrorResponse } from "../../services/api/client";
import {
  marketplaceService,
  MarketplaceListing,
  MarketplaceCreator,
} from "../../services/api/marketplace";
import { MarketplaceListingModal } from "../marketplace/MarketplaceListingModal";
import { MarketplaceCreatorModal } from "../marketplace/MarketplaceCreatorModal";

interface CollaborationDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  collaboration: Collaboration | null;
  onActionComplete?: () => void;
}

const statusVariantMap: Record<
  CollaborationStatus,
  "success" | "warning" | "info" | "danger" | "neutral"
> = {
  pending: "warning",
  negotiating: "info",
  accepted: "success",
  declined: "danger",
  cancelled: "neutral",
  completed: "success",
};

export function CollaborationDetailModal({
  isOpen,
  onClose,
  collaboration,
  onActionComplete,
}: CollaborationDetailModalProps) {
  const [actionInFlight, setActionInFlight] = useState<null | "accept" | "decline" | "approve">(
    null,
  );
  const [error, setError] = useState("");
  const [responseMessage, setResponseMessage] = useState("");

  // Marketplace popup state
  const [listingsCache, setListingsCache] = useState<MarketplaceListing[] | null>(null);
  const [creatorsCache, setCreatorsCache] = useState<MarketplaceCreator[] | null>(null);
  const [listingPopup, setListingPopup] = useState<{
    listing: MarketplaceListing | null;
    notFound?: string;
  } | null>(null);
  const [creatorPopup, setCreatorPopup] = useState<{
    creator: MarketplaceCreator | null;
    notFound?: string;
  } | null>(null);
  const [loadingMarketplace, setLoadingMarketplace] = useState<null | "listing" | "creator">(null);

  const openListingPopup = async (listingId: string) => {
    setLoadingMarketplace("listing");
    try {
      let listings = listingsCache;
      if (!listings) {
        listings = await marketplaceService.getListings();
        setListingsCache(listings);
      }
      const found = listings.find((l) => l.id === listingId);
      if (found) {
        setListingPopup({ listing: found });
      } else {
        setListingPopup({
          listing: null,
          notFound:
            "This collaboration offer is not currently visible on the marketplace (the hotel may be unverified or its profile is incomplete).",
        });
      }
    } catch {
      setListingPopup({
        listing: null,
        notFound: "Failed to load collaboration offer details.",
      });
    } finally {
      setLoadingMarketplace(null);
    }
  };

  const openCreatorPopup = async (creatorId: string) => {
    setLoadingMarketplace("creator");
    try {
      let creators = creatorsCache;
      if (!creators) {
        creators = await marketplaceService.getCreators();
        setCreatorsCache(creators);
      }
      const found = creators.find((c) => c.id === creatorId);
      if (found) {
        setCreatorPopup({ creator: found });
      } else {
        setCreatorPopup({
          creator: null,
          notFound:
            "This creator is not currently visible on the marketplace (they may be unverified or their profile is incomplete).",
        });
      }
    } catch {
      setCreatorPopup({
        creator: null,
        notFound: "Failed to load creator details.",
      });
    } finally {
      setLoadingMarketplace(null);
    }
  };

  if (!collaboration) return null;

  const formatDate = (dateString?: string) => {
    if (!dateString) return "N/A";
    return new Date(dateString).toLocaleDateString();
  };

  const getCompensationText = (collab: Collaboration) => {
    switch (collab.collaboration_type) {
      case "Paid":
        return `${getCurrencySymbol(collab.currency || "USD")}${Number(collab.paid_amount || 0).toLocaleString()} Paid`;
      case "Discount":
        return `${collab.discount_percentage || 0}% Discount`;
      case "Free Stay":
        return `${collab.stay_nights || collab.free_stay_min_nights || 0} Nights Free Stay`;
      default:
        return "TBD";
    }
  };

  const handleClose = () => {
    setError("");
    setResponseMessage("");
    setActionInFlight(null);
    onClose();
  };

  const runAction = async (action: "accept" | "decline" | "approve") => {
    setActionInFlight(action);
    setError("");
    try {
      if (action === "accept") {
        await collaborationsService.respondAsHotel(
          collaboration.id,
          "accepted",
          responseMessage || undefined,
        );
      } else if (action === "decline") {
        await collaborationsService.respondAsHotel(
          collaboration.id,
          "declined",
          responseMessage || undefined,
        );
      } else {
        await collaborationsService.approveAsHotel(collaboration.id);
      }
      onActionComplete?.();
      handleClose();
    } catch (err) {
      const message =
        err instanceof ApiErrorResponse
          ? (err.data.detail as string) || "Action failed"
          : "Unexpected error";
      setError(message);
    } finally {
      setActionInFlight(null);
    }
  };

  const canRespond =
    collaboration.status === "pending" && collaboration.initiator_type === "creator";
  const canApprove = collaboration.status === "negotiating" && !collaboration.hotel_agreed_at;
  const showActions = canRespond || canApprove;

  return (
    <>
      <Modal isOpen={isOpen} onClose={handleClose} title="Collaboration Details" size="lg">
        <div className="space-y-6">
          {/* Header: Parties & Status */}
          <div className="flex flex-col md:flex-row justify-between items-center bg-gray-50 p-4 rounded-xl border border-gray-100">
            {/* Creator */}
            <button
              type="button"
              onClick={() => openCreatorPopup(collaboration.creator_id)}
              disabled={loadingMarketplace === "creator"}
              className="flex items-center space-x-3 rounded-lg p-1 -m-1 hover:bg-gray-100 transition-colors disabled:opacity-60 text-left"
              title={`View ${collaboration.creator_name}'s marketplace profile`}
            >
              <Avatar
                src={collaboration.creator_profile_picture}
                alt={collaboration.creator_name}
                name={collaboration.creator_name}
                size="lg"
                className="border border-gray-200"
              />
              <div>
                <p className="text-sm font-bold text-gray-900 hover:underline">
                  {collaboration.creator_name}
                  {loadingMarketplace === "creator" && (
                    <span className="ml-2 text-xs text-gray-500">Loading…</span>
                  )}
                </p>
                <p className="text-xs text-gray-500">Creator</p>
              </div>
            </button>
            {/* Status */}
            <div className="my-4 md:my-0 flex flex-col items-center">
              <Badge variant={statusVariantMap[collaboration.status]}>
                {collaboration.status.toUpperCase()}
              </Badge>
              <span className="text-xs text-gray-400 mt-1">
                Via {collaboration.initiator_type === "creator" ? "Application" : "Invitation"}
              </span>
            </div>

            {/* Hotel */}
            <button
              type="button"
              onClick={() => openListingPopup(collaboration.listing_id)}
              disabled={loadingMarketplace === "listing"}
              className="flex items-center space-x-3 text-right rounded-lg p-1 -m-1 hover:bg-gray-100 transition-colors disabled:opacity-60"
              title={`View ${collaboration.listing_name} marketplace offer`}
            >
              <div>
                <p className="text-sm font-bold text-gray-900 hover:underline">
                  {collaboration.hotel_name}
                  {loadingMarketplace === "listing" && (
                    <span className="ml-2 text-xs text-gray-500">Loading…</span>
                  )}
                </p>
                <p className="text-xs text-gray-500">{collaboration.listing_name}</p>
              </div>
              <div className="w-12 h-12 rounded-lg bg-gray-200 flex items-center justify-center text-gray-500 font-bold border border-gray-200">
                {collaboration.hotel_name.charAt(0)}
              </div>
            </button>
          </div>

          {/* Terms & Dates */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
              <h4 className="text-xs uppercase tracking-wide text-gray-400 font-semibold mb-2">
                Compensation
              </h4>
              <p className="text-lg font-medium text-gray-900">
                {getCompensationText(collaboration)}
              </p>
              <p className="text-sm text-gray-500">{collaboration.collaboration_type} Agreement</p>
            </div>
            <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
              <h4 className="text-xs uppercase tracking-wide text-gray-400 font-semibold mb-2">
                Dates
              </h4>
              <div className="flex items-center space-x-2">
                <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">
                  {collaboration.travel_date_from
                    ? formatDate(collaboration.travel_date_from)
                    : "TBD"}
                </span>
                <span className="text-gray-400">→</span>
                <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">
                  {collaboration.travel_date_to ? formatDate(collaboration.travel_date_to) : "TBD"}
                </span>
              </div>
              {collaboration.preferred_months && !collaboration.travel_date_from && (
                <p className="text-sm text-gray-500 mt-2">
                  Preferred: {collaboration.preferred_months.join(", ")}
                </p>
              )}
            </div>
          </div>

          {/* Deliverables */}
          <div>
            <h4 className="text-sm font-semibold text-gray-900 mb-3 border-b pb-2">Deliverables</h4>
            <div className="space-y-4">
              {collaboration.platform_deliverables.map((group, i) => (
                <div key={i}>
                  <h5 className="text-xs font-bold text-gray-600 mb-2 uppercase">
                    {group.platform}
                  </h5>
                  <ul className="space-y-2">
                    {group.deliverables.map((item) => (
                      <li
                        key={item.id}
                        className="flex items-center justify-between text-sm bg-gray-50 p-2 rounded"
                      >
                        <div className="flex items-center space-x-2">
                          <span
                            className={`w-2 h-2 rounded-full ${item.status === "completed" ? "bg-green-500" : "bg-yellow-400"}`}
                          ></span>
                          <span>
                            {item.quantity}x {item.type}
                          </span>
                        </div>
                        <Badge
                          size="sm"
                          variant={item.status === "completed" ? "success" : "neutral"}
                        >
                          {item.status}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          {/* Application Note */}
          {collaboration.why_great_fit && (
            <div className="bg-blue-50 p-4 rounded-lg border border-blue-100">
              <h4 className="text-xs font-bold text-blue-800 uppercase mb-1">Application Note</h4>
              <p className="text-sm text-blue-900 italic">"{collaboration.why_great_fit}"</p>
            </div>
          )}

          {/* Timeline */}
          <div className="text-xs text-gray-400 pt-4 border-t flex flex-wrap gap-4">
            <span>Created: {formatDate(collaboration.created_at)}</span>
            {collaboration.updated_at && (
              <span>Last Updated: {formatDate(collaboration.updated_at)}</span>
            )}
            {collaboration.completed_at && (
              <span>Completed: {formatDate(collaboration.completed_at)}</span>
            )}
            {collaboration.cancelled_at && (
              <span>Cancelled: {formatDate(collaboration.cancelled_at)}</span>
            )}
          </div>

          {/* Admin Actions */}
          {showActions && (
            <div className="pt-4 border-t border-gray-200 space-y-3">
              <div>
                <h4 className="text-sm font-semibold text-gray-900">
                  Act on behalf of {collaboration.hotel_name}
                </h4>
                <p className="text-xs text-gray-500">
                  {canRespond
                    ? "The hotel has not yet responded to this creator application."
                    : "Approve the current terms. The creator must also approve before the collaboration is finalized."}
                </p>
              </div>

              {canRespond && (
                <Textarea
                  placeholder="Optional message to the creator…"
                  value={responseMessage}
                  onChange={(e) => setResponseMessage(e.target.value)}
                  rows={2}
                />
              )}

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-800">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2">
                {canRespond && (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => runAction("decline")}
                      disabled={actionInFlight !== null}
                      className="border-red-300 text-red-700 hover:bg-red-50"
                    >
                      {actionInFlight === "decline" ? "Declining…" : "Decline"}
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => runAction("accept")}
                      disabled={actionInFlight !== null}
                    >
                      {actionInFlight === "accept" ? "Accepting…" : "Accept on behalf of Hotel"}
                    </Button>
                  </>
                )}
                {canApprove && (
                  <Button
                    variant="primary"
                    onClick={() => runAction("approve")}
                    disabled={actionInFlight !== null}
                  >
                    {actionInFlight === "approve" ? "Approving…" : "Approve on behalf of Hotel"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </Modal>

      <MarketplaceListingModal
        isOpen={!!listingPopup}
        onClose={() => setListingPopup(null)}
        listing={listingPopup?.listing ?? null}
        notFoundMessage={listingPopup?.notFound}
      />

      <MarketplaceCreatorModal
        isOpen={!!creatorPopup}
        onClose={() => setCreatorPopup(null)}
        creator={creatorPopup?.creator ?? null}
        notFoundMessage={creatorPopup?.notFound}
      />
    </>
  );
}
