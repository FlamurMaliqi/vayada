import { describe, expect, it, vi } from "vitest";

import { createPgPmsInboxEmailRoutes } from "./pmsInboxDeliveryEmailRoutes.js";

describe("PMS Inbox property email routes", () => {
  it.each([
    [null, null, "guest_email_unavailable"],
    ["guest@example.test", null, "approved_sender_unavailable"],
    [
      "guest@example.test",
      { fromAddress: "stay@example.test", senderStatus: "disabled", policyStatus: "allowed" },
      "approved_sender_unavailable",
    ],
    [
      "guest@example.test",
      { fromAddress: "stay@example.test", senderStatus: "approved", policyStatus: "disallowed" },
      "email_policy_disallowed",
    ],
  ])("holds an unavailable property route", async (guestEmail, sender, reasonCode) => {
    const routes = createPgPmsInboxEmailRoutes({
      connectionString: "",
      pool: { query: vi.fn(async () => ({ rows: sender ? [sender] : [] })) } as never,
    });
    await expect(
      routes.resolveDeliveryEmailRoute({
        propertyId: "property-1",
        threadId: "thread-1",
        guestEmail,
      }),
    ).resolves.toEqual({ state: "held", reasonCode });
  });

  it("returns the approved property sender only to the delivery boundary", async () => {
    const routes = createPgPmsInboxEmailRoutes({
      connectionString: "",
      pool: {
        query: vi.fn(async () => ({
          rows: [
            {
              fromAddress: " Stay <stay@example.test> ",
              senderStatus: "approved",
              policyStatus: "allowed",
            },
          ],
        })),
      } as never,
    });
    await expect(
      routes.resolveDeliveryEmailRoute({
        propertyId: "property-1",
        threadId: "thread-1",
        guestEmail: " guest@example.test ",
      }),
    ).resolves.toEqual({
      state: "ready",
      recipientEmail: "guest@example.test",
      senderEmail: "Stay <stay@example.test>",
    });
    const reply = await routes.resolveReplyRoutes({
      propertyId: "property-1",
      threads: [{ threadId: "thread-1", guestEmail: "guest@example.test" }],
    });
    expect(reply[0]?.route).toEqual({
      state: "ready",
      channel: "email",
      providerChannel: null,
      reasonCode: null,
    });
    expect(JSON.stringify(reply)).not.toContain("stay@example.test");
  });
});
