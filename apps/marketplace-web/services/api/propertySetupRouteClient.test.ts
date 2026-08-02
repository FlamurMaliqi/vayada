import { buildPropertySetupRoute, type PropertySetupRouteReadModel } from "@vayada/domain-hotels";
import { describe, expect, it } from "vitest";

import {
  createPropertySetupRouteClient,
  parsePropertySetupRouteReadModel,
  type PropertySetupRouteHttpClient,
} from "./propertySetupRouteClient";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";

describe("createPropertySetupRouteClient", () => {
  it("loads the encoded protected route and forwards RequestInit unchanged", async () => {
    const response = routeWire();
    const calls: Array<{ endpoint: string; options?: RequestInit }> = [];
    const get = async <T>(endpoint: string, options?: RequestInit): Promise<T> => {
      calls.push({ endpoint, options });
      return response as T;
    };
    const client = createPropertySetupRouteClient({ get });
    const controller = new AbortController();
    const options: RequestInit = {
      signal: controller.signal,
      headers: { "X-Request-Trace": "setup-shell" },
      cache: "no-store",
    };

    await expect(client.getRoute(propertyId.toUpperCase(), options)).resolves.toBe(response);
    expect(calls).toEqual([
      {
        endpoint: `/api/hotel-setup/properties/${propertyId.toUpperCase()}/route`,
        options,
      },
    ]);
    expect(calls[0]?.options).toBe(options);
  });

  it("preserves AbortSignal failures from the authenticated HTTP client", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Setup request was replaced.", "AbortError"));
    const get = async <T>(_endpoint: string, options?: RequestInit): Promise<T> => {
      throw options?.signal?.reason;
    };
    const client = createPropertySetupRouteClient({ get });

    await expect(client.getRoute(propertyId, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects malformed route data and cross-property responses", async () => {
    const malformed = { ...routeWire(), contractVersion: "property-setup-route.v2" };
    const otherProperty = routeWire("33333333-3333-4333-8333-333333333333");

    await expect(
      createPropertySetupRouteClient(clientReturning(malformed)).getRoute(propertyId),
    ).rejects.toThrow("Property setup route data is invalid");
    await expect(
      createPropertySetupRouteClient(clientReturning(otherProperty)).getRoute(propertyId),
    ).rejects.toThrow("Property setup route data is invalid");
  });
});

describe("parsePropertySetupRouteReadModel", () => {
  it("accepts each canonical active route without mutating the wire value", () => {
    for (const selectedTracks of [
      ["creator_marketplace"],
      ["hotel_operations"],
      ["hotel_operations", "creator_marketplace"],
    ] as const) {
      const route = routeWire(propertyId, selectedTracks);
      expect(parsePropertySetupRouteReadModel(route)).toBe(route);
    }
  });

  it("fails closed for extra keys, discontinuous positions, or dishonest progress", () => {
    const route = routeWire();
    expect(parsePropertySetupRouteReadModel({ ...route, unexpected: true })).toBeNull();
    expect(
      parsePropertySetupRouteReadModel({
        ...route,
        steps: route.steps.map((step, index) => (index === 1 ? { ...step, position: 99 } : step)),
      }),
    ).toBeNull();
    expect(
      parsePropertySetupRouteReadModel({
        ...route,
        progress: { ...route.progress, complete: route.progress.complete + 1 },
      }),
    ).toBeNull();
  });
});

function clientReturning(value: unknown): PropertySetupRouteHttpClient {
  return { get: async <T>() => value as T };
}

function routeWire(
  routePropertyId = propertyId,
  selectedTracks: readonly ("hotel_operations" | "creator_marketplace")[] = ["creator_marketplace"],
): PropertySetupRouteReadModel {
  return buildPropertySetupRoute({
    organizationId,
    propertyId: routePropertyId,
    selectedTracks,
    trackRevision: 1,
    session: null,
    ownerFacts: [],
  });
}
