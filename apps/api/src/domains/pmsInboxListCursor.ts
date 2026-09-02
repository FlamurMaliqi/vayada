import { createHash } from "node:crypto";

import type { PmsInboxReadPort } from "./pmsInbox.js";

type ListInput = Parameters<PmsInboxReadPort["listThreads"]>[0];
export type PmsInboxListCursor = { activityAt: string; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function pmsInboxListFilterFingerprint(input: ListInput): string {
  const assignee = input.assignee === "me" ? input.actorMembershipId : (input.assignee ?? null);
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.propertyId,
        input.attentionState ?? null,
        input.unread ?? null,
        input.channel ?? null,
        assignee,
        input.search?.toLowerCase() ?? null,
      ]),
    )
    .digest("hex");
}

export function encodePmsInboxListCursor(
  fingerprint: string,
  cursor: { activityAt: Date | string; id: string },
): string {
  const activityAt =
    cursor.activityAt instanceof Date ? cursor.activityAt.toISOString() : cursor.activityAt;
  const preciseActivityAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(activityAt)
    ? activityAt
    : activityAt.replace(/(\.\d{3})Z$/, "$1000Z");
  return Buffer.from(
    JSON.stringify({ v: 1, q: fingerprint, p: [preciseActivityAt, cursor.id] }),
  ).toString("base64url");
}

export function decodePmsInboxListCursor(
  token: string,
  fingerprint: string,
): PmsInboxListCursor | null {
  try {
    if (!/^(?=.{2,4096}$)(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/.test(token)) throw 0;
    const decoded = Buffer.from(token, "base64url");
    if (decoded.toString("base64url") !== token) throw 0;
    const value = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "p,q,v" ||
      value.v !== 1 ||
      value.q !== fingerprint ||
      !Array.isArray(value.p) ||
      value.p.length !== 2
    )
      throw 0;
    const [activityAt, id] = value.p;
    if (
      typeof activityAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(activityAt) ||
      new Date(`${activityAt.slice(0, 23)}Z`).toISOString() !== `${activityAt.slice(0, 23)}Z` ||
      typeof id !== "string" ||
      !UUID.test(id)
    )
      throw 0;
    return { activityAt, id };
  } catch {
    return null;
  }
}
