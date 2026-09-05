import { addPmsBlocker } from "./productionPmsContext.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";

/** Validate normalized source candidates before the migration can write them. */
export function validatePmsMessagingSource(
  context: PmsBuildContext,
  records: PmsTargetRecord[],
): void {
  const messagesByThread = new Map<string, PmsTargetRecord[]>();
  const identities = new Map<string, PmsTargetRecord[]>();
  for (const record of records) {
    const row = record.row;
    if (!["message_threads", "messages"].includes(record.targetTable)) continue;
    const isMessage = record.targetTable === "messages";
    const key = JSON.stringify(
      isMessage
        ? [record.targetTable, row["threadId"], row["sourceMessageId"]]
        : [record.targetTable, row["propertyId"], row["source"], row["sourceThreadId"]],
    );
    const group = identities.get(key) ?? [];
    group.push(record);
    identities.set(key, group);
    if (isMessage) {
      const threadId = String(row["threadId"]);
      const messages = messagesByThread.get(threadId) ?? [];
      messages.push(record);
      messagesByThread.set(threadId, messages);
    }
  }
  for (const group of identities.values())
    if (group.length > 1)
      for (const record of group)
        mismatch(context, record, "INBOX_DUPLICATE_PROVIDER_ID", "provider identity is not unique");

  for (const thread of records.filter((record) => record.targetTable === "message_threads")) {
    const messages = messagesByThread.get(thread.targetId) ?? [];
    const expected: Record<string, unknown> = pmsMessageSummary(messages);
    const fields = Object.keys(expected).filter((field) => thread.row[field] !== expected[field]);
    if (fields.length)
      mismatch(
        context,
        thread,
        "INBOX_THREAD_SUMMARY_MISMATCH",
        `mismatched fields: ${fields.join(", ")}`,
      );
  }
}

export function pmsMessageSummary(messages: PmsTargetRecord[]) {
  let latest: PmsTargetRecord | undefined;
  let unread = 0;
  for (const message of messages) {
    if (message.row["direction"] === "inbound" && message.row["readAt"] === null) unread++;
    // Same ordering as target intake: sent_at DESC, id DESC; arrival order is irrelevant.
    const time = Date.parse(String(message.row["sentAt"]));
    const latestTime = latest ? Date.parse(String(latest.row["sentAt"])) : -Infinity;
    if (time > latestTime || (time === latestTime && message.targetId > latest!.targetId))
      latest = message;
  }
  return {
    unreadCount: unread,
    lastMessageAt: latest?.row["sentAt"] ?? null,
    // PostgreSQL LEFT counts Unicode code points, not JavaScript UTF-16 code units.
    lastMessagePreview: latest ? [...String(latest.row["body"])].slice(0, 280).join("") : null,
    lastMessageDirection: latest?.row["direction"] ?? null,
  };
}

function mismatch(
  context: PmsBuildContext,
  record: PmsTargetRecord,
  code: string,
  reason: string,
): void {
  addPmsBlocker(
    context,
    code,
    `pms.${record.sourceTable}`,
    record.sourceId,
    `Property ${record.row["propertyId"]}: ${record.targetTable} ${reason}; review source reconciliation before migration`,
  );
}
