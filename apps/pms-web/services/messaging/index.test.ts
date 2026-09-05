import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get: mocks.get, post: mocks.post },
  pmsOperationsRequestOptions: { cache: "no-store" },
}));

import { messagingService } from ".";

describe("target Inbox client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps list filters property scoped and sends search only to the API", async () => {
    mocks.get.mockResolvedValueOnce({ items: [], nextCursor: null });

    await messagingService.listThreads("property/1", {
      attentionState: "needs_attention",
      unread: true,
      channel: "ota",
      assignee: "me",
      search: "Ada Lee",
    });

    const endpoint = String(mocks.get.mock.calls[0]?.[0]);
    expect(endpoint).toContain("/api/pms/properties/property%2F1/messaging/threads?");
    expect(new URL(endpoint, "https://api.example").searchParams).toEqual(
      new URLSearchParams({
        attentionState: "needs_attention",
        limit: "25",
        unread: "true",
        channel: "ota",
        assignee: "me",
        search: "Ada Lee",
      }),
    );
    expect(mocks.get).toHaveBeenCalledWith(endpoint, { cache: "no-store" });
  });

  it("uses a unique idempotency header for a manual reply", async () => {
    mocks.post.mockResolvedValueOnce({ messageId: "message-1" });

    await messagingService.reply("property-1", "thread/1", {
      expectedThreadVersion: 7,
      text: "Your room is ready.",
      attachmentMediaIds: [],
    });

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/messaging/threads/thread%2F1/messages",
      {
        expectedThreadVersion: 7,
        text: "Your room is ready.",
        attachmentMediaIds: [],
      },
      {
        cache: "no-store",
        headers: {
          "Idempotency-Key": expect.stringMatching(/^pms-inbox:reply:/),
        },
      },
    );
  });

  it("reuses the command key after a transport failure for the same reply", async () => {
    const input = {
      expectedThreadVersion: 7,
      text: "Please keep this reply singular.",
      attachmentMediaIds: [],
    };
    mocks.post.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce({
      messageId: "message-1",
    });

    await expect(messagingService.reply("property-1", "thread-1", input)).rejects.toThrow(
      "Failed to fetch",
    );
    await messagingService.reply("property-1", "thread-1", input);

    expect(mocks.post.mock.calls[0]?.[2]?.headers["Idempotency-Key"]).toBe(
      mocks.post.mock.calls[1]?.[2]?.headers["Idempotency-Key"],
    );
  });

  it("loads direct candidates through the Inbox permission boundary", async () => {
    mocks.get.mockResolvedValueOnce({
      items: [{ guestBookingId: "direct", source: "direct_booking", status: "confirmed" }],
    });

    await expect(messagingService.listDirectBookings("property-1")).resolves.toEqual([
      { guestBookingId: "direct", source: "direct_booking", status: "confirmed" },
    ]);
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/messaging/direct-bookings",
      { cache: "no-store" },
    );
  });
});
