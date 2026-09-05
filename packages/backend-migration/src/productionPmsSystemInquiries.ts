import { optionalObject, optionalText, requiredText, uuid } from "./productionBookingValues.js";
import { addPmsBlocker } from "./productionPmsContext.js";
import { pmsMessageSummary } from "./productionPmsMessagingParity.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";

/** Approved read-history conversion, after validating the unmodified source summaries. */
export function normalizePmsSystemInquiries(
  context: PmsBuildContext,
  records: PmsTargetRecord[],
): void {
  const sourceMessages = new Map(
    (context.rowsByTable.get("messages") ?? []).map((row) => [
      String(row.data["id"]).toLowerCase(),
      row.data,
    ]),
  );
  const sourceThreads = new Map(
    (context.rowsByTable.get("message_threads") ?? []).map((row) => [
      String(row.data["id"]).toLowerCase(),
      row.data,
    ]),
  );
  const threads = new Map(
    records
      .filter((row) => row.targetTable === "message_threads")
      .map((row) => [row.targetId, row]),
  );
  const messagesByThread = new Map<string, PmsTargetRecord[]>();
  const changedThreads = new Set<string>();
  for (const message of records.filter((row) => row.targetTable === "messages")) {
    const threadId = String(message.row["threadId"]);
    const messages = messagesByThread.get(threadId) ?? [];
    messages.push(message);
    messagesByThread.set(threadId, messages);
    const raw = optionalObject(sourceMessages.get(message.targetId)?.["raw_payload"]);
    const sender = raw["sender"];
    const sourceBody = raw["message"];
    if (
      typeof sender !== "string" ||
      sender.trim().toLowerCase() !== "system" ||
      (String(message.row["body"]).trim().toLowerCase() !== "inquiry" &&
        !(typeof sourceBody === "string" && sourceBody.trim().toLowerCase() === "inquiry"))
    )
      continue;
    const thread = threads.get(threadId);
    try {
      if (
        !thread ||
        thread.row["source"] !== "channex" ||
        thread.row["providerChannel"] !== "airbnb"
      )
        throw new Error("system inquiry requires a verified Airbnb thread");
      if (
        requiredText(raw["message"], "inquiry message") !== String(message.row["body"]).trim() ||
        optionalText(raw["booking_id"], "inquiry booking_id")
      )
        throw new Error("system inquiry payload conflicts with retained message classification");
      const meta = optionalObject(raw["meta"]);
      const inquiryId = requiredText(meta["live_feed_event_id"], "inquiry identity");
      const details = optionalObject(meta["booking_details"]);
      const hotelId = uuid(sourceThreads.get(threadId)?.["hotel_id"], "inquiry hotel_id");
      const propertyId = uuid(details["property_id"], "inquiry property_id");
      const binding = context.connectionByHotel.get(hotelId);
      if (!binding || uuid(binding.data["channex_property_id"], "inquiry binding") !== propertyId)
        throw new Error("system inquiry property does not match its canonical Channex binding");
      for (const [field, expected] of [
        ["id", message.row["sourceMessageId"]],
        ["message_thread_id", thread.row["sourceThreadId"]],
        ["inquiry_id", inquiryId],
        ["provider_inquiry_id", inquiryId],
      ] as const) {
        const supplied = optionalText(raw[field], `inquiry ${field}`);
        if (supplied && supplied !== expected)
          throw new Error(`system inquiry ${field} conflicts with retained identity`);
      }
      if (
        raw["property_id"] != null &&
        uuid(raw["property_id"], "inquiry property_id") !== propertyId
      )
        throw new Error("system inquiry property identities conflict");
      message.row["direction"] = "inbound";
      message.row["senderType"] = "system";
      changedThreads.add(threadId);
    } catch (error) {
      addPmsBlocker(
        context,
        "INBOX_SYSTEM_INQUIRY_REQUIRES_REVIEW",
        "pms.messages",
        message.sourceId,
        `Property ${message.row["propertyId"]}: ${error instanceof Error ? error.message : "invalid system inquiry evidence"}`,
      );
    }
  }
  for (const threadId of changedThreads) {
    const summary = pmsMessageSummary(messagesByThread.get(threadId)!);
    const thread = threads.get(threadId)!;
    thread.row["unreadCount"] = summary.unreadCount;
    thread.row["lastMessageDirection"] = summary.lastMessageDirection;
  }
}
