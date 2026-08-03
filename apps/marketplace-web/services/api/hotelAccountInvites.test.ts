import { afterEach, describe, expect, it, vi } from "vitest";

import { setVayadaApiBearerTokenProvider } from "@vayada/marketplace-shared/api/client";

import { hotelAccountInvitesService } from "./hotelAccountInvites";

describe("hotel account invite API routing", () => {
  afterEach(() => {
    setVayadaApiBearerTokenProvider(null);
    vi.unstubAllGlobals();
  });

  it("never sends the signed-in bearer token during public lookup", async () => {
    setVayadaApiBearerTokenProvider(() => "active-workos-token");
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      return Response.json({
        contractVersion: "hotel-account-invite.v1",
        identity: { emailHint: "o***@example.test" },
        organization: { displayName: "Alpenrose Hospitality" },
        property: { displayName: "Hotel Alpenrose" },
        selectedTracks: ["creator_marketplace"],
        handoffPath: "/setup",
        expiresAt: "2026-08-20T12:00:00.000Z",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await hotelAccountInvitesService.lookup("VAY-0123456789abcdef");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(request?.headers).get("authorization")).toBeNull();
    expect(request?.method).toBe("POST");
  });
});
