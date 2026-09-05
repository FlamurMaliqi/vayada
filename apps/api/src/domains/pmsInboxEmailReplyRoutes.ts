import type { PmsInboxEmailReplyRoute, PmsInboxEmailReplyRouteReadPort } from "./pmsInbox.js";

export async function resolvePmsInboxEmailReplyRoutes(
  port: PmsInboxEmailReplyRouteReadPort,
  propertyId: string,
  threads: readonly { threadId: string; guestEmail: string | null }[],
): Promise<Map<string, PmsInboxEmailReplyRoute>> {
  if (!threads.length) return new Map();
  const resolved = await port.resolveReplyRoutes({ propertyId, threads });
  const expected = new Set(threads.map((thread) => thread.threadId));
  const routes = new Map<string, PmsInboxEmailReplyRoute>();
  for (const item of resolved) {
    if (item.propertyId !== propertyId || !expected.has(item.threadId) || routes.has(item.threadId))
      throw new Error("PMS Inbox email reply route scope mismatch");
    routes.set(item.threadId, item.route);
  }
  if (routes.size !== expected.size) throw new Error("PMS Inbox email reply route is incomplete");
  return routes;
}
