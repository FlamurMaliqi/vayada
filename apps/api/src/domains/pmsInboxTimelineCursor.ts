import { createHash } from "node:crypto";

export type PmsInboxTimelineCursor = {
  occurredAt: string;
  kind: "internal_note" | "message";
  id: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function pmsInboxTimelineFingerprint(propertyId: string, threadId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([propertyId, threadId]))
    .digest("hex");
}

export function encodePmsInboxTimelineCursor(
  fingerprint: string,
  cursor: { occurredAt: Date | string; kind: "internal_note" | "message"; id: string },
): string {
  const occurredAt =
    cursor.occurredAt instanceof Date ? cursor.occurredAt.toISOString() : cursor.occurredAt;
  const preciseOccurredAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(occurredAt)
    ? occurredAt
    : occurredAt.replace(/(\.\d{3})Z$/, "$1000Z");
  return Buffer.from(
    JSON.stringify({ v: 1, q: fingerprint, p: [preciseOccurredAt, cursor.kind, cursor.id] }),
  ).toString("base64url");
}

export function decodePmsInboxTimelineCursor(
  token: string,
  fingerprint: string,
): PmsInboxTimelineCursor | null {
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
      value.p.length !== 3
    )
      throw 0;
    const [occurredAt, kind, id] = value.p;
    if (
      typeof occurredAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(occurredAt) ||
      new Date(`${occurredAt.slice(0, 23)}Z`).toISOString() !== `${occurredAt.slice(0, 23)}Z` ||
      (kind !== "internal_note" && kind !== "message") ||
      typeof id !== "string" ||
      !UUID.test(id)
    )
      throw 0;
    return { occurredAt, kind, id };
  } catch {
    return null;
  }
}
