import { describe, expect, it } from "vitest";

import {
  parseCreateHotelSetupHandoffRequest,
  parseCreateHotelSetupHandoffResponse,
  parseExchangeHotelSetupHandoffRequest,
  parseExchangeHotelSetupHandoffResponse,
  parseHotelSetupHandoffError,
} from "./hotelSetupHandoff.js";

const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const code = "7_8FkqvJvK_vOS5Ke4iFAScHY6LmDsQUviRLKfS1dCk";

describe("hotel setup handoff wire contract", () => {
  it("accepts only the exact creation request", () => {
    const request = {
      propertyId,
      taskId: "rooms_rates_availability",
      planRevision: "tracks:1|rooms_rates_availability:revision-1:fresh",
    };

    expect(parseCreateHotelSetupHandoffRequest(request)).toEqual(request);
    expect(
      parseCreateHotelSetupHandoffRequest({
        ...request,
        destinationRoute: "https://attacker.example/handoff",
      }),
    ).toBeNull();
    expect(
      parseCreateHotelSetupHandoffRequest({ ...request, propertyId: "property-1" }),
    ).toBeNull();
  });

  it("accepts only launch URLs containing one opaque code", () => {
    expect(
      parseCreateHotelSetupHandoffResponse({
        launchUrl: `https://pms.vayada.com/handoff?code=${code}`,
        expiresAt: "2026-07-26T18:05:00.000Z",
      }),
    ).toEqual({
      launchUrl: `https://pms.vayada.com/handoff?code=${code}`,
      expiresAt: "2026-07-26T18:05:00.000Z",
    });
    expect(
      parseCreateHotelSetupHandoffResponse({
        launchUrl: `https://pms.vayada.com/handoff?code=${code}&propertyId=${propertyId}`,
        expiresAt: "2026-07-26T18:05:00.000Z",
      }),
    ).toBeNull();
  });

  it("accepts one exact opaque exchange code", () => {
    expect(parseExchangeHotelSetupHandoffRequest({ code })).toEqual({ code });
    expect(
      parseExchangeHotelSetupHandoffRequest({ code, organizationId: "organization-1" }),
    ).toBeNull();
    expect(parseExchangeHotelSetupHandoffRequest({ code: "short" })).toBeNull();
  });

  it("requires the task and destination route key to match", () => {
    const response = {
      propertyId,
      taskId: "guest_settings_policies",
      issuedPlanRevision: "tracks:1|guest_settings_policies:revision-1:fresh",
      destinationRouteKey: "booking.guest_settings_policies",
      returnUrl: `https://marketplace.vayada.com/setup?propertyId=${propertyId}`,
    };

    expect(parseExchangeHotelSetupHandoffResponse(response)).toEqual(response);
    expect(
      parseExchangeHotelSetupHandoffResponse({
        ...response,
        destinationRouteKey: "pms.rooms_rates_availability",
      }),
    ).toBeNull();
    expect(
      parseExchangeHotelSetupHandoffResponse({
        ...response,
        returnUrl: `https://marketplace.vayada.com/setup?propertyId=${propertyId}&next=https://attacker.example`,
      }),
    ).toBeNull();
    expect(
      parseExchangeHotelSetupHandoffResponse({
        ...response,
        returnUrl:
          "https://marketplace.vayada.com/setup?propertyId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).toBeNull();
  });

  it("parses only the non-disclosing handoff errors", () => {
    expect(parseHotelSetupHandoffError({ code: "invalid_handoff" })).toEqual({
      code: "invalid_handoff",
    });
    expect(parseHotelSetupHandoffError({ code: "refresh_plan" })).toEqual({
      code: "refresh_plan",
    });
    expect(parseHotelSetupHandoffError({ code: "invalid_handoff", propertyId })).toBeNull();
  });
});
