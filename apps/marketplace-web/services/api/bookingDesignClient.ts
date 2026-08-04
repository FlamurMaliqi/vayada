import {
  parseBookingDesignReadinessResult,
  parseBookingDesignRevision,
  parseUpsertBookingDesignRequest,
  type BookingDesignReadinessResult,
  type BookingDesignRevision,
  type UpsertBookingDesignRequest,
} from "@vayada/domain-booking";

import { ApiErrorResponse } from "./client";
import { targetApiClient } from "./targetClient";

type HttpClient = {
  get<T>(endpoint: string, options?: RequestInit): Promise<T>;
  put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

export function createBookingDesignClient(http: HttpClient) {
  return {
    async load(propertyId: string, options?: RequestInit): Promise<BookingDesignRevision | null> {
      try {
        const parsed = parseBookingDesignRevision(
          await http.get<unknown>(path(propertyId), options),
        );
        if (!parsed || parsed.propertyId !== propertyId.toLowerCase()) throw invalid("read");
        return parsed;
      } catch (error) {
        if (error instanceof ApiErrorResponse && error.status === 404) return null;
        throw error;
      }
    },

    async loadReadiness(
      scope: Readonly<{ organizationId: string; propertyId: string }>,
      options?: RequestInit,
    ): Promise<BookingDesignReadinessResult> {
      let value: unknown;
      try {
        value = await http.get<unknown>(readinessPath(scope.propertyId), options);
      } catch (error) {
        if (!(error instanceof ApiErrorResponse) || error.status !== 503) throw error;
        value = error.data;
      }
      const parsed = parseBookingDesignReadinessResult(value, scope);
      if (!parsed) throw invalid("readiness");
      return parsed;
    },

    async save(
      propertyId: string,
      request: UpsertBookingDesignRequest,
    ): Promise<BookingDesignRevision> {
      const parsedRequest = parseUpsertBookingDesignRequest({
        expectedRevision: request.expectedRevision,
        primaryColor: request.choices.primaryColor,
        fontPairing: request.choices.fontPairing,
      });
      if (!parsedRequest) throw new TypeError("The Booking design choices are invalid.");
      const value = await http.put<unknown>(
        path(propertyId),
        {
          expectedRevision: parsedRequest.expectedRevision,
          primaryColor: parsedRequest.choices.primaryColor,
          fontPairing: parsedRequest.choices.fontPairing,
        },
        { headers: { "Idempotency-Key": await key(propertyId, parsedRequest) } },
      );
      if (
        !record(value) ||
        (value.outcome !== "created" &&
          value.outcome !== "updated" &&
          value.outcome !== "idempotent_replay")
      ) {
        throw invalid("save");
      }
      const parsed = parseBookingDesignRevision(value.design);
      if (
        !parsed ||
        parsed.propertyId !== propertyId.toLowerCase() ||
        parsed.revision !== parsedRequest.expectedRevision + 1 ||
        parsed.choices.primaryColor !== parsedRequest.choices.primaryColor ||
        parsed.choices.fontPairing !== parsedRequest.choices.fontPairing
      ) {
        throw invalid("save");
      }
      return parsed;
    },
  };
}

export const bookingDesignClient = createBookingDesignClient(targetApiClient);

function path(propertyId: string): string {
  return `/api/booking/properties/${encodeURIComponent(propertyId)}/booking-design`;
}

function readinessPath(propertyId: string): string {
  return `${path(propertyId)}/readiness`;
}

async function key(propertyId: string, request: UpsertBookingDesignRequest): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ propertyId, request })),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `booking-design:${propertyId}:${hex.slice(0, 40)}`;
}

function invalid(operation: string): Error {
  return new Error(`The Booking design ${operation} response is invalid. Refresh and try again.`);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
