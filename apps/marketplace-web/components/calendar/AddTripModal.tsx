"use client";

import { useEffect, useRef, useState } from "react";
import { XMarkIcon, PlusIcon, CalendarIcon } from "@heroicons/react/24/outline";
import { createTripWriteIdempotencyKey, tripService } from "@/services/api/trips";
import type { TripResponse } from "@/services/api/trips";
import {
  isDefiniteValidationSubmissionFailure,
  resolvePerWriteSubmissionIdempotencyState,
  type PerWriteSubmissionIdempotencyState,
} from "@/lib/utils/submissionIdempotency";

interface Collaboration {
  id: string;
  type: string;
  hotelName: string;
  deliverables: string;
}

interface AddTripModalProps {
  isOpen: boolean;
  onClose: () => void;
  trip?: TripResponse | null;
  onTripSaved?: (trip: TripResponse) => void;
  onTripDeleted?: (tripId: string) => void;
}

const EMPTY_FORM = {
  tripName: "",
  location: "",
  startDate: "",
  endDate: "",
  notes: "",
};

export function AddTripModal({
  isOpen,
  onClose,
  trip,
  onTripSaved,
  onTripDeleted,
}: AddTripModalProps) {
  const [formData, setFormData] = useState({
    tripName: "",
    location: "",
    startDate: "",
    endDate: "",
    notes: "",
  });

  const [collaborations, setCollaborations] = useState<Collaboration[]>([]);
  const [ambiguousCollaborationIds, setAmbiguousCollaborationIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [tripDatesLocked, setTripDatesLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submissionRef = useRef<PerWriteSubmissionIdempotencyState | null>(null);
  const savedTripRef = useRef<TripResponse | null>(null);
  const savedTripFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    submissionRef.current = null;
    savedTripRef.current = null;
    savedTripFingerprintRef.current = null;
    if (!isOpen) return;

    setFormData(
      trip
        ? {
            tripName: trip.name,
            location: trip.location || "",
            startDate: trip.start_date.split("T")[0],
            endDate: trip.end_date.split("T")[0],
            notes: trip.notes || "",
          }
        : EMPTY_FORM,
    );
    setCollaborations([]);
    setAmbiguousCollaborationIds(new Set());
    setTripDatesLocked(Boolean(trip?.external_collaborations.length));
    setError("");
  }, [isOpen, trip]);

  if (!isOpen) return null;

  const handleAddCollaboration = () => {
    const newCollab: Collaboration = {
      id: Math.random().toString(36).substr(2, 9),
      type: "Custom / External",
      hotelName: "",
      deliverables: "",
    };
    setCollaborations([...collaborations, newCollab]);
  };

  const handleRemoveCollaboration = (id: string) => {
    if (ambiguousCollaborationIds.has(id)) return;
    setCollaborations(collaborations.filter((c) => c.id !== id));
  };

  const handleUpdateCollaboration = (id: string, updates: Partial<Collaboration>) => {
    if (ambiguousCollaborationIds.has(id)) return;
    setCollaborations(collaborations.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  };

  const resetForm = () => {
    setFormData(EMPTY_FORM);
    setCollaborations([]);
    setAmbiguousCollaborationIds(new Set());
    setTripDatesLocked(false);
    setError("");
    submissionRef.current = null;
    savedTripRef.current = null;
    savedTripFingerprintRef.current = null;
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);

    try {
      const tripRequestFingerprint = {
        name: formData.tripName,
        location: formData.location,
        start_date: formData.startDate,
        end_date: formData.endDate,
        notes: formData.notes,
      };
      const tripFingerprint = JSON.stringify({
        tripId: trip?.id ?? null,
        tripRequest: tripRequestFingerprint,
      });
      const externalCollaborationRequests = collaborations
        .filter((collab) => collab.hotelName.trim())
        .map((collab) => ({
          collaboration: collab,
          collaborationId: collab.id,
          keyName: `child:${collab.id}`,
          data: {
            title: collab.hotelName,
            hotel_name: collab.hotelName,
            collaboration_type: collab.type as "Custom / External" | "Paid" | "Free Stay",
            start_date: formData.startDate,
            end_date: formData.endDate,
            deliverables: collab.deliverables || undefined,
          },
        }));
      const submission = resolvePerWriteSubmissionIdempotencyState(
        submissionRef.current,
        [
          {
            keyName: "trip",
            fingerprint: tripFingerprint,
          },
          ...externalCollaborationRequests.map(({ keyName, data }) => ({
            keyName,
            fingerprint: JSON.stringify(data),
          })),
        ],
        (keyName) =>
          keyName === "trip"
            ? createTripWriteIdempotencyKey(
                savedTripRef.current || trip ? "trip.update" : "trip.create",
                savedTripRef.current?.id ?? trip?.id ?? "new",
              )
            : createTripWriteIdempotencyKey("external-collaboration.create", keyName),
      );
      submissionRef.current = submission;

      let savedTrip = savedTripRef.current;
      if (!savedTrip) {
        savedTrip = trip
          ? await tripService.updateTrip(
              trip.id,
              {
                name: formData.tripName,
                location: formData.location || null,
                start_date: formData.startDate,
                end_date: formData.endDate,
                notes: formData.notes || null,
              },
              { idempotencyKey: submission.keys.trip },
            )
          : await tripService.createTrip(
              {
                name: formData.tripName,
                location: formData.location || undefined,
                start_date: formData.startDate,
                end_date: formData.endDate,
                notes: formData.notes || undefined,
              },
              { idempotencyKey: submission.keys.trip },
            );
        savedTripRef.current = savedTrip;
        savedTripFingerprintRef.current = tripFingerprint;
      } else if (savedTripFingerprintRef.current !== tripFingerprint) {
        savedTrip = await tripService.updateTrip(
          savedTrip.id,
          {
            name: formData.tripName,
            location: formData.location || null,
            start_date: formData.startDate,
            end_date: formData.endDate,
            notes: formData.notes || null,
          },
          { idempotencyKey: submission.keys.trip },
        );
        savedTripRef.current = savedTrip;
        savedTripFingerprintRef.current = tripFingerprint;
      }

      let failedCollaborationCount = 0;
      let savedCollaborationCount = 0;
      const failedCollaborationIds = new Set<string>();
      const ambiguousCollaborations = new Map<string, Collaboration>();
      for (const request of externalCollaborationRequests) {
        try {
          await tripService.createExternalCollaboration(
            { trip_id: savedTrip.id, ...request.data },
            { idempotencyKey: submission.keys[request.keyName] },
          );
          savedCollaborationCount += 1;
        } catch (childError) {
          failedCollaborationCount += 1;
          failedCollaborationIds.add(request.collaborationId);
          if (!isDefiniteValidationSubmissionFailure(childError)) {
            ambiguousCollaborations.set(request.collaborationId, request.collaboration);
          }
        }
      }

      if (failedCollaborationCount > 0) {
        setCollaborations((current) =>
          current
            .filter((collaboration) => failedCollaborationIds.has(collaboration.id))
            .map((collaboration) => ambiguousCollaborations.get(collaboration.id) ?? collaboration),
        );
        setAmbiguousCollaborationIds(new Set(ambiguousCollaborations.keys()));
        if (savedCollaborationCount > 0 || ambiguousCollaborations.size > 0) {
          setTripDatesLocked(true);
          setFormData((current) => ({
            ...current,
            startDate: tripRequestFingerprint.start_date,
            endDate: tripRequestFingerprint.end_date,
          }));
        }
        setError(
          `Trip ${trip ? "updated" : "created"}, but ${failedCollaborationCount} collaboration${failedCollaborationCount === 1 ? "" : "s"} could not be saved. ${ambiguousCollaborations.size > 0 ? "Rows marked Retry pending are locked so they can be replayed safely." : "Fix the details and retry."} Completed writes will not be duplicated.`,
        );
        onTripSaved?.(savedTrip);
        return;
      }

      onTripSaved?.(savedTrip);
      resetForm();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save trip";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!trip || !window.confirm("Delete this trip?")) return;

    setError("");
    setSaving(true);
    try {
      await tripService.deleteTrip(trip.id);
      onTripDeleted?.(trip.id);
      resetForm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete trip");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative z-50">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Modal Content */}
      <div className="fixed inset-0 z-10 overflow-y-auto pointer-events-none">
        <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
          <div className="relative transform overflow-hidden rounded-[32px] bg-white text-left shadow-2xl transition-all sm:my-8 sm:w-full sm:max-w-xl pointer-events-auto">
            <div className="absolute right-0 top-0 pr-6 pt-6">
              <button
                type="button"
                className="rounded-full p-2 text-gray-400 hover:text-gray-500 hover:bg-gray-100 transition-colors focus:outline-none"
                onClick={handleClose}
              >
                <span className="sr-only">Close</span>
                <XMarkIcon className="h-6 w-6" aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-10">
              {/* Header */}
              <div className="flex items-center gap-3 mb-8">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-plane h-6 w-6 text-gray-900"
                >
                  <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"></path>
                </svg>
                <h3 className="text-[22px] font-bold text-gray-900">
                  {trip ? "Edit Trip" : "Add Trip"}
                </h3>
              </div>

              {error && (
                <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm font-medium">
                  {error}
                </div>
              )}

              <div className="space-y-6">
                {/* Trip Name */}
                <div>
                  <label htmlFor="tripName" className="block text-sm font-bold text-gray-900 mb-2">
                    Trip Name *
                  </label>
                  <input
                    type="text"
                    id="tripName"
                    required
                    className="w-full px-4 py-3 rounded-xl border border-gray-100 bg-[#f8f9fa] focus:outline-none focus:ring-2 focus:ring-primary-500/10 focus:border-primary-500 transition-all placeholder:text-gray-400 font-medium text-gray-900"
                    placeholder="e.g., Summer Vacation"
                    value={formData.tripName}
                    onChange={(e) => setFormData({ ...formData, tripName: e.target.value })}
                  />
                </div>

                {/* Location */}
                <div>
                  <label htmlFor="location" className="block text-sm font-bold text-gray-900 mb-2">
                    Location
                  </label>
                  <input
                    type="text"
                    id="location"
                    className="w-full px-4 py-3 rounded-xl border border-gray-100 bg-[#f8f9fa] focus:outline-none focus:ring-2 focus:ring-primary-500/10 focus:border-primary-500 transition-all placeholder:text-gray-400 font-medium text-gray-900"
                    placeholder="e.g., Paris, France"
                    value={formData.location}
                    onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                  />
                </div>

                {/* Dates */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="startDate"
                      className="block text-sm font-bold text-gray-900 mb-2"
                    >
                      Start Date *
                    </label>
                    <div className="relative group">
                      <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                        <CalendarIcon className="h-5 w-5 text-gray-900" />
                      </div>
                      <input
                        type="date"
                        id="startDate"
                        required
                        disabled={tripDatesLocked}
                        className="w-full pl-11 pr-4 py-3 rounded-xl border border-gray-100 bg-[#f8f9fa] focus:outline-none focus:ring-2 focus:ring-primary-500/10 focus:border-primary-500 transition-all text-gray-900 font-medium appearance-none disabled:cursor-not-allowed disabled:text-gray-500"
                        value={formData.startDate}
                        onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="endDate" className="block text-sm font-bold text-gray-900 mb-2">
                      End Date *
                    </label>
                    <div className="relative group">
                      <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                        <CalendarIcon className="h-5 w-5 text-gray-900" />
                      </div>
                      <input
                        type="date"
                        id="endDate"
                        required
                        disabled={tripDatesLocked}
                        className="w-full pl-11 pr-4 py-3 rounded-xl border border-gray-100 bg-[#f8f9fa] focus:outline-none focus:ring-2 focus:ring-primary-500/10 focus:border-primary-500 transition-all text-gray-900 font-medium appearance-none disabled:cursor-not-allowed disabled:text-gray-500"
                        value={formData.endDate}
                        onChange={(e) => setFormData({ ...formData, endDate: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
                {tripDatesLocked && (
                  <p className="-mt-4 text-xs font-medium text-gray-500">
                    Dates are locked because a collaboration has already been saved or is awaiting a
                    safe retry.
                  </p>
                )}

                {/* Collaborations Header */}
                <div className="flex items-center justify-between pt-2">
                  <h4 className="text-[17px] font-bold text-gray-900">Collaborations</h4>
                  <button
                    type="button"
                    onClick={handleAddCollaboration}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-100 text-[13px] font-bold text-gray-900 hover:bg-gray-50 transition-all shadow-sm"
                  >
                    <PlusIcon className="w-4 h-4" />
                    Add Collaboration
                  </button>
                </div>

                {/* Collaboration Cards / Empty State */}
                <div className="space-y-4">
                  {collaborations.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-6 border-2 border-dashed border-gray-100 rounded-2xl bg-white">
                      <span className="text-[15px] text-gray-400 font-medium">
                        No collaborations added yet
                      </span>
                    </div>
                  ) : (
                    collaborations.map((collab, index) => {
                      const isAmbiguous = ambiguousCollaborationIds.has(collab.id);
                      return (
                        <div
                          key={collab.id}
                          className="relative p-6 rounded-2xl bg-[#f8f9fa] border border-gray-100 space-y-4"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 text-gray-400">
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="24"
                                height="24"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="lucide lucide-building2 h-4 w-4"
                              >
                                <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"></path>
                                <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"></path>
                                <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"></path>
                                <path d="M10 6h4"></path>
                                <path d="M10 10h4"></path>
                                <path d="M10 14h4"></path>
                                <path d="M10 18h4"></path>
                              </svg>
                              <span className="text-xs font-bold uppercase tracking-wider">
                                Collaboration {index + 1}
                              </span>
                              {isAmbiguous && (
                                <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                                  Retry pending
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRemoveCollaboration(collab.id)}
                              disabled={isAmbiguous}
                              title={
                                isAmbiguous
                                  ? "This collaboration must be retried unchanged."
                                  : undefined
                              }
                              className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 transition-all disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <XMarkIcon className="w-5 h-5" />
                            </button>
                          </div>

                          <div className="space-y-3">
                            <div className="relative">
                              <select
                                disabled={isAmbiguous}
                                className="w-full px-4 py-3 rounded-xl border border-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500/10 focus:border-primary-500 transition-all appearance-none bg-white text-gray-900 font-medium pl-10 text-[14px] disabled:cursor-not-allowed disabled:text-gray-500"
                                value={collab.type}
                                onChange={(e) =>
                                  handleUpdateCollaboration(collab.id, { type: e.target.value })
                                }
                              >
                                <option value="Custom / External">Custom / External</option>
                                <option value="Paid">Paid</option>
                                <option value="Free Stay">Free Stay</option>
                              </select>
                              <div className="absolute inset-y-0 left-3.5 flex items-center pointer-events-none">
                                <PlusIcon className="w-4 h-4 text-gray-400" />
                              </div>
                              <div className="absolute inset-y-0 right-3 flex items-center pr-1 pointer-events-none">
                                <svg
                                  className="h-5 w-5 text-gray-400"
                                  viewBox="0 0 20 20"
                                  fill="currentColor"
                                >
                                  <path
                                    fillRule="evenodd"
                                    d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                                    clipRule="evenodd"
                                  />
                                </svg>
                              </div>
                            </div>

                            <input
                              type="text"
                              disabled={isAmbiguous}
                              className="w-full px-4 py-3 rounded-xl border border-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500/10 focus:border-primary-500 transition-all placeholder:text-gray-400 font-medium bg-white text-gray-900 text-[14px] disabled:cursor-not-allowed disabled:text-gray-500"
                              placeholder="Hotel/Property Name"
                              value={collab.hotelName}
                              onChange={(e) =>
                                handleUpdateCollaboration(collab.id, { hotelName: e.target.value })
                              }
                            />

                            <input
                              type="text"
                              disabled={isAmbiguous}
                              className="w-full px-4 py-3 rounded-xl border border-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500/10 focus:border-primary-500 transition-all placeholder:text-gray-400 font-medium bg-white text-gray-900 text-[14px] disabled:cursor-not-allowed disabled:text-gray-500"
                              placeholder="Deliverables (e.g., 3 Reels, 5 Stories)"
                              value={collab.deliverables}
                              onChange={(e) =>
                                handleUpdateCollaboration(collab.id, {
                                  deliverables: e.target.value,
                                })
                              }
                            />
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Notes */}
                <div>
                  <label htmlFor="notes" className="block text-sm font-bold text-gray-900 mb-2">
                    Notes
                  </label>
                  <textarea
                    id="notes"
                    rows={4}
                    className="w-full px-4 py-3 rounded-xl border border-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500/10 focus:border-primary-500 transition-all placeholder:text-gray-400 font-medium resize-none bg-white text-gray-900 text-[14px]"
                    placeholder="Add any additional notes..."
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap justify-end gap-3 mt-10">
                {trip && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={saving}
                    className="mr-auto rounded-xl border border-red-200 px-6 py-3 text-[15px] font-bold text-red-600 transition-all hover:bg-red-50 disabled:opacity-50"
                  >
                    Delete
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-8 py-3 rounded-xl border border-gray-100 bg-white text-[15px] text-gray-900 font-bold hover:bg-gray-50 transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-10 py-3 rounded-xl bg-[#4353e4] text-white text-[15px] font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20 active:scale-[0.98] disabled:opacity-50"
                >
                  {saving ? "Saving..." : trip ? "Save Changes" : "Add Trip"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
