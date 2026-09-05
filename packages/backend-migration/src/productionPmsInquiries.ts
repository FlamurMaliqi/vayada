import {
  jsonObject,
  optionalObject,
  optionalText,
  requiredText,
  uuid,
} from "./productionBookingValues.js";
import { addPmsBlocker } from "./productionPmsContext.js";
import { pmsMessageSummary } from "./productionPmsMessagingParity.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";

/** Approved inquiry conversion, after validating the unmodified source summaries. */
export function normalizePmsInquiries(context: PmsBuildContext, records: PmsTargetRecord[]): void {
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
    const senderKind = typeof sender === "string" ? sender.trim().toLowerCase() : "";
    const systemNotice =
      senderKind === "system" &&
      (String(message.row["body"]).trim().toLowerCase() === "inquiry" ||
        (typeof sourceBody === "string" && sourceBody.trim().toLowerCase() === "inquiry"));
    const inquiryValue = raw["inquiry"];
    const explicitInquiry =
      [
        raw["provider_inquiry_id"],
        raw["inquiry_id"],
        optionalObject(raw["meta"])["live_feed_event_id"],
      ].some((value) => value != null && value !== "") ||
      (inquiryValue != null &&
        (typeof inquiryValue !== "object" ||
          Array.isArray(inquiryValue) ||
          Object.keys(optionalObject(inquiryValue)).length > 0)) ||
      ["message_type", "conversation_type"].some(
        (field) => typeof raw[field] === "string" && raw[field].toLowerCase().includes("inquiry"),
      );
    if (!systemNotice && !explicitInquiry) continue;
    const thread = threads.get(threadId);
    try {
      if (
        !thread ||
        thread.row["source"] !== "channex" ||
        thread.row["providerChannel"] !== "airbnb"
      )
        throw new Error("inquiry requires a verified Airbnb thread");
      if (
        typeof sourceBody !== "string" ||
        sourceBody.trim() !== String(message.row["body"]).trim() ||
        optionalText(raw["booking_id"], "inquiry booking_id")
      )
        throw new Error("inquiry payload conflicts with retained message classification");
      const senderType = ["guest", "system", "channel"].includes(senderKind)
        ? senderKind
        : ["property", "property_user", "host", "hotel"].includes(senderKind)
          ? "property_user"
          : null;
      if (
        !senderType ||
        (senderType !== "system" &&
          message.row["direction"] !== (senderType === "guest" ? "inbound" : "outbound"))
      )
        throw new Error("inquiry sender conflicts with retained direction or is unsupported");
      const meta = raw["meta"] == null ? {} : jsonObject(raw["meta"], "inquiry meta");
      const inquiry = raw["inquiry"] == null ? {} : jsonObject(raw["inquiry"], "inquiry");
      const inquiryIds = [
        raw["provider_inquiry_id"],
        raw["inquiry_id"],
        inquiry["id"],
        meta["live_feed_event_id"],
      ]
        .map((value) => optionalText(value, "inquiry identity"))
        .filter((value) => value !== null);
      const inquiryId = requiredText(inquiryIds[0], "inquiry identity");
      if (inquiryIds.some((id) => id !== inquiryId)) throw new Error("inquiry identities conflict");
      const details =
        meta["booking_details"] == null
          ? {}
          : jsonObject(meta["booking_details"], "inquiry booking_details");
      const hotelId = uuid(sourceThreads.get(threadId)?.["hotel_id"], "inquiry hotel_id");
      const propertyIds = [
        details["property_id"],
        raw["property_id"],
        inquiry["property_id"],
        meta["property_id"],
      ]
        .filter((value) => value != null)
        .map((value) => uuid(value, "inquiry property_id"));
      const propertyId = uuid(propertyIds[0], "inquiry property_id");
      const binding = context.connectionByHotel.get(hotelId);
      if (!binding || uuid(binding.data["channex_property_id"], "inquiry binding") !== propertyId)
        throw new Error("inquiry property does not match its canonical Channex binding");
      if (propertyIds.some((id) => id !== propertyId))
        throw new Error("inquiry property identities conflict");
      for (const field of ["channel", "provider", "ota_name", "source"]) {
        const channel = optionalText(raw[field], `inquiry ${field}`);
        if (
          channel &&
          !["airbnb", "abnb"].includes(channel.replace(/[^a-z0-9]/gi, "").toLowerCase())
        )
          throw new Error("inquiry channel conflicts with its Airbnb thread");
      }
      for (const [field, expected] of [
        ["id", message.row["sourceMessageId"]],
        ["message_id", message.row["sourceMessageId"]],
        ["source_message_id", message.row["sourceMessageId"]],
        ["message_thread_id", thread.row["sourceThreadId"]],
        ["thread_id", thread.row["sourceThreadId"]],
      ] as const) {
        const supplied = optionalText(raw[field], `inquiry ${field}`);
        if (supplied && supplied !== expected)
          throw new Error(`inquiry ${field} conflicts with retained identity`);
      }
      for (const field of ["channel_booking_id", "source_booking_id"])
        if (optionalText(raw[field], `inquiry ${field}`))
          throw new Error("inquiry payload contains a booking reference");
      const stay = inquiryStay([details, meta, inquiry, raw]);
      if (!thread.row["guestBookingId"]) {
        if (thread.row["sourceBookingId"] && thread.row["sourceBookingId"] !== inquiryId)
          throw new Error("inquiry conflicts with the thread source reference");
        for (const [field, value] of Object.entries(stay)) {
          const previous = thread.row[field];
          if (previous != null && value != null && previous !== value)
            throw new Error(`inquiry ${field} conflicts across retained messages`);
        }
        thread.row["conversationContextState"] = "inquiry";
        thread.row["sourceBookingId"] = inquiryId;
        for (const [field, value] of Object.entries(stay))
          if (value != null) thread.row[field] = value;
      }
      if (senderType === "system") message.row["direction"] = "inbound";
      message.row["senderType"] = senderType;
      changedThreads.add(threadId);
    } catch (error) {
      addPmsBlocker(
        context,
        systemNotice ? "INBOX_SYSTEM_INQUIRY_REQUIRES_REVIEW" : "INBOX_INQUIRY_REQUIRES_REVIEW",
        "pms.messages",
        message.sourceId,
        `Property ${message.row["propertyId"]}: ${error instanceof Error ? error.message : "invalid inquiry evidence"}`,
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

function inquiryStay(sources: Record<string, unknown>[]) {
  const arrival = supplied(
    sources,
    ["arrival_date", "checkin_date", "check_in", "checkin"],
    inquiryDate,
  );
  const departure = supplied(
    sources,
    ["departure_date", "checkout_date", "check_out", "checkout"],
    inquiryDate,
  );
  if ((arrival === null) !== (departure === null) || (arrival && departure && arrival >= departure))
    throw new Error("inquiry dates must be an ordered pair");
  return {
    inquiryArrivalDate: arrival,
    inquiryDepartureDate: departure,
    inquiryAdults: supplied(sources, ["adults", "adult_count", "number_of_adults"], inquiryCount),
    inquiryChildren: supplied(
      sources,
      ["children", "children_count", "number_of_children"],
      inquiryCount,
    ),
  };
}

function supplied<T>(
  sources: Record<string, unknown>[],
  fields: string[],
  parse: (value: unknown) => T,
): T | null {
  let result: T | null = null;
  for (const source of sources) {
    for (const field of fields) {
      const value = source[field];
      if (value == null || value === "") continue;
      const parsed = parse(value);
      if (result !== null && result !== parsed)
        throw new Error(`inquiry ${fields[0]} aliases conflict`);
      result = parsed;
    }
  }
  return result;
}

function inquiryDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("inquiry date must be YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value)
    throw new Error("inquiry date must be a real calendar date");
  return value;
}

function inquiryCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100)
    throw new Error("inquiry count must be an integer from 0 through 100");
  return value;
}
