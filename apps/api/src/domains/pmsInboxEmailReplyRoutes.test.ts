import { describe, expect, it } from "vitest";

import type { PmsInboxEmailReplyRoute } from "./pmsInbox.js";
import { resolvePmsInboxEmailReplyRoutes } from "./pmsInboxEmailReplyRoutes.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const THREAD = "22222222-2222-4222-8222-222222222222";

describe("PMS Inbox email reply routes", () => {
  it.each([
    { state: "ready", channel: "email", providerChannel: null, reasonCode: null },
    { state: "held", channel: null, providerChannel: null, reasonCode: "guest_email_unavailable" },
    {
      state: "held",
      channel: null,
      providerChannel: null,
      reasonCode: "approved_sender_unavailable",
    },
    { state: "held", channel: null, providerChannel: null, reasonCode: "email_policy_disallowed" },
  ] satisfies PmsInboxEmailReplyRoute[])(
    "accepts the authoritative $reasonCode route",
    async (route) => {
      const routes = await resolvePmsInboxEmailReplyRoutes(
        {
          async resolveReplyRoutes() {
            return [{ propertyId: PROPERTY, threadId: THREAD, route }];
          },
        },
        PROPERTY,
        [{ threadId: THREAD, guestEmail: "guest@example.com" }],
      );
      expect(routes.get(THREAD)).toEqual(route);
    },
  );

  it("fails closed on missing or cross-property results", async () => {
    await expect(
      resolvePmsInboxEmailReplyRoutes(
        {
          async resolveReplyRoutes() {
            return [];
          },
        },
        PROPERTY,
        [{ threadId: THREAD, guestEmail: null }],
      ),
    ).rejects.toThrow("incomplete");
    await expect(
      resolvePmsInboxEmailReplyRoutes(
        {
          async resolveReplyRoutes({ threads }) {
            return threads.map(({ threadId }) => ({
              propertyId: "other",
              threadId,
              route: { state: "ready", channel: "email", providerChannel: null, reasonCode: null },
            }));
          },
        },
        PROPERTY,
        [{ threadId: THREAD, guestEmail: null }],
      ),
    ).rejects.toThrow("scope mismatch");
  });
});
