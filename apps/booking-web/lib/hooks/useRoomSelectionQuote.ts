"use client";
import { useEffect, useState } from "react";
import { sameRoomSelection } from "@/lib/roomSelection";
import {
  bookingService,
  type BookingCreateRequest,
  type BookingQuote,
} from "@/services/api/booking";
import {
  expireCheckoutIdempotencyKeyAt,
  getCheckoutIdempotencyKey,
} from "@/lib/storage/bookingDraft";

/** Canonical pricing applies booking-wide discounts/add-ons once across every room. */
export function useRoomSelectionQuote(slug: string, input: BookingCreateRequest | null) {
  const identity = input ? JSON.stringify(input) : "";
  const [result, setResult] = useState<{
    identity: string;
    slug: string;
    quote?: BookingQuote;
    error?: string;
  }>();
  useEffect(() => {
    if (!identity || !slug) return;
    let canceled = false;
    const request: BookingCreateRequest = JSON.parse(identity);
    const key = getCheckoutIdempotencyKey("selection-price", `${slug}:${identity}`);
    void bookingService
      .quote(slug, request, key)
      .then((quote) => {
        if (
          !sameRoomSelection(quote.roomSelection, request.roomSelection) ||
          !quote.expiresAt ||
          !(Date.parse(quote.expiresAt) > Date.now())
        )
          throw new Error("Room selection pricing is unavailable. Please search again.");
        expireCheckoutIdempotencyKeyAt("selection-price", `${slug}:${identity}`, quote.expiresAt);
        if (!canceled) setResult({ identity, slug, quote });
      })
      .catch((error: unknown) => {
        if (!canceled)
          setResult({
            identity,
            slug,
            error:
              error instanceof Error ? error.message : "Room selection pricing is unavailable.",
          });
      });
    return () => {
      canceled = true;
    };
  }, [identity, slug]);
  return result?.identity === identity && result.slug === slug ? result : undefined;
}
