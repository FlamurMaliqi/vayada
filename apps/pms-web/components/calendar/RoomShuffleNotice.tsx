"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRightIcon, XMarkIcon } from "@heroicons/react/24/outline";

import Modal from "@/components/Modal";
import {
  listPmsRoomShuffleHistory,
  type PmsRoomShuffleHistoryItem,
} from "@/services/api/pmsPropertyClient";

export default function RoomShuffleNotice({
  bookingCount,
  eventId,
}: {
  bookingCount: number;
  eventId: string;
}) {
  const [toastVisible, setToastVisible] = useState(bookingCount > 0);
  const [logOpen, setLogOpen] = useState(false);
  const [items, setItems] = useState<PmsRoomShuffleHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [failedCursor, setFailedCursor] = useState<string>();
  const loadingRef = useRef(false);
  const requestGeneration = useRef(0);
  const returnFocusRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    requestGeneration.current += 1;
    loadingRef.current = false;
    setItems([]);
    setCursor(null);
    setLoaded(false);
    setLoading(false);
    setError("");
    setFailedCursor(undefined);
    setLogOpen(false);
    if (bookingCount < 1) {
      setToastVisible(false);
      return;
    }
    setToastVisible(true);
    const timeout = globalThis.setTimeout(() => setToastVisible(false), 5_000);
    return () => globalThis.clearTimeout(timeout);
  }, [bookingCount, eventId]);

  const loadHistory = async (nextCursor?: string) => {
    if (loadingRef.current) return;
    const generation = requestGeneration.current;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    setFailedCursor(undefined);
    try {
      const page = await listPmsRoomShuffleHistory(50, nextCursor);
      if (generation !== requestGeneration.current) return;
      setItems((current) => (nextCursor ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch {
      if (generation !== requestGeneration.current) return;
      setFailedCursor(nextCursor);
      setError("Room-move history couldn’t be loaded. Retry to view the log.");
    } finally {
      if (generation !== requestGeneration.current) return;
      loadingRef.current = false;
      setLoading(false);
    }
  };

  const openLog = () => {
    returnFocusRef.current?.focus();
    setToastVisible(false);
    setLogOpen(true);
    if (!loaded && !loading) void loadHistory();
  };

  const showToast = bookingCount > 0 && toastVisible;
  if (bookingCount < 1 && !logOpen) return null;

  return (
    <>
      <span ref={returnFocusRef} tabIndex={-1} className="sr-only">
        Calendar
      </span>

      {showToast && (
        <div
          role="status"
          className="fixed bottom-5 left-4 right-4 z-40 flex items-center justify-between gap-3 rounded-xl bg-gray-950 px-4 py-3 text-sm text-white shadow-xl sm:left-auto sm:right-6 sm:max-w-md"
        >
          <span>
            {bookingCount} {bookingCount === 1 ? "booking" : "bookings"} rearranged for optimal room
            usage
          </span>
          <button
            type="button"
            onClick={openLog}
            className="shrink-0 font-medium text-primary-300 underline underline-offset-4 hover:text-primary-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            View log
          </button>
        </div>
      )}

      {logOpen && (
        <Modal onClose={() => setLogOpen(false)} maxWidth="lg" ariaLabel="Room move history">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-primary-600">
                Calendar movement log
              </p>
              <h2 className="mt-1 text-xl font-semibold text-gray-950">Room moves</h2>
              <p className="mt-1 text-sm text-gray-500">
                Automatic moves stay within the original room type.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close room move history"
              onClick={() => setLogOpen(false)}
              className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-600"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-sm text-red-700">{error}</p>
              <button
                type="button"
                onClick={() => void loadHistory(failedCursor)}
                className="mt-2 text-sm font-medium text-red-800 underline underline-offset-4"
              >
                Retry
              </button>
            </div>
          )}

          {!error && loaded && items.length === 0 && (
            <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">
              No automatic room moves have been recorded.
            </p>
          )}

          {items.length > 0 && (
            <ol className="divide-y divide-gray-100 border-y border-gray-100">
              {items.map((item) => (
                <li key={item.shuffleId} className="py-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-gray-950">
                      {item.bookingReference ?? "Booking unavailable"}
                    </p>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium capitalize text-gray-600">
                      {item.reason}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-sm text-gray-700">
                    <RoomLabel
                      value={item.fromRoom?.label ?? (item.fromRoom ? null : "Unassigned")}
                    />
                    <ArrowRightIcon className="h-4 w-4 shrink-0 text-gray-400" />
                    <RoomLabel value={item.toRoom.label} />
                  </div>
                  <p className="mt-2 text-xs text-gray-400">
                    {new Date(item.occurredAt).toLocaleString()}
                  </p>
                </li>
              ))}
            </ol>
          )}

          {loading && (
            <p role="status" className="mt-4 text-sm text-gray-500">
              Loading room moves…
            </p>
          )}
          {!loading && !error && cursor && (
            <button
              type="button"
              onClick={() => void loadHistory(cursor)}
              className="mt-4 w-full rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-600"
            >
              Load older moves
            </button>
          )}
        </Modal>
      )}
    </>
  );
}

function RoomLabel({ value }: { value: string | null }) {
  return (
    <span className="rounded-md border border-gray-200 bg-white px-2 py-1 font-medium">
      {value ? `Room ${value}` : "Room unavailable"}
    </span>
  );
}
