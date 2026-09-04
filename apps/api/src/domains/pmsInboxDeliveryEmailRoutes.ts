import pg, { type QueryResultRow } from "pg";

import type { PmsInboxEmailReplyRouteReadPort } from "./pmsInbox.js";

export type PmsInboxDeliveryEmailRoutePort = {
  resolveDeliveryEmailRoute(input: {
    propertyId: string;
    threadId: string;
    guestEmail: string | null;
  }): Promise<
    | { state: "ready"; recipientEmail: string; senderEmail: string }
    | {
        state: "held";
        reasonCode:
          | "guest_email_unavailable"
          | "approved_sender_unavailable"
          | "email_policy_disallowed";
      }
  >;
};

type Pool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};

type SenderRow = { fromAddress: string; senderStatus: string; policyStatus: string };

export function createPgPmsInboxEmailRoutes(config: {
  connectionString: string;
  pool?: Pool;
}): PmsInboxEmailReplyRouteReadPort & PmsInboxDeliveryEmailRoutePort {
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: 2 });
  const loadSender = async (propertyId: string) => {
    const result = await pool.query<SenderRow>(
      `SELECT route.from_address AS "fromAddress", route.sender_status AS "senderStatus",
              route.policy_status AS "policyStatus"
       FROM pms.inbox_email_routes route
       JOIN hotel_catalog.properties property ON property.id = route.property_id
       WHERE route.property_id = $1::uuid AND property.lifecycle_status = 'active'`,
      [propertyId],
    );
    return result.rows[0] ?? null;
  };
  const resolve = (sender: SenderRow | null, guestEmail: string | null) => {
    const recipientEmail = guestEmail?.trim() || null;
    if (!recipientEmail)
      return { state: "held" as const, reasonCode: "guest_email_unavailable" as const };
    if (!sender || sender.senderStatus !== "approved")
      return { state: "held" as const, reasonCode: "approved_sender_unavailable" as const };
    if (sender.policyStatus !== "allowed")
      return { state: "held" as const, reasonCode: "email_policy_disallowed" as const };
    return { state: "ready" as const, recipientEmail, senderEmail: sender.fromAddress.trim() };
  };
  return {
    async resolveReplyRoutes({ propertyId, threads }) {
      const sender = await loadSender(propertyId);
      return threads.map(({ threadId, guestEmail }) => {
        const route = resolve(sender, guestEmail);
        return {
          propertyId,
          threadId,
          route:
            route.state === "ready"
              ? {
                  state: "ready" as const,
                  channel: "email" as const,
                  providerChannel: null,
                  reasonCode: null,
                }
              : {
                  state: "held" as const,
                  channel: null,
                  providerChannel: null,
                  reasonCode: route.reasonCode,
                },
        };
      });
    },
    async resolveDeliveryEmailRoute({ propertyId, guestEmail }) {
      return resolve(await loadSender(propertyId), guestEmail);
    },
  };
}

export function createUnavailablePmsInboxDeliveryEmailRoutePort(): PmsInboxDeliveryEmailRoutePort {
  return {
    async resolveDeliveryEmailRoute({ guestEmail }) {
      return guestEmail?.trim()
        ? { state: "held", reasonCode: "approved_sender_unavailable" }
        : { state: "held", reasonCode: "guest_email_unavailable" };
    },
  };
}
