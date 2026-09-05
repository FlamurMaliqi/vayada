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
      const inquiry = raw["inquiry"] == null ? {} : jsonObject(raw["inquiry"], "inquiry");
      const nestedId = optionalText(inquiry["id"], "inquiry id");
      if (nestedId && nestedId !== inquiryId)
        throw new Error("system inquiry id conflicts with retained identity");
      for (const field of ["channel_booking_id", "source_booking_id"])
        if (optionalText(raw[field], `inquiry ${field}`))
          throw new Error("system inquiry payload contains a booking reference");
      const stay = inquiryStay([details, meta, inquiry, raw]);
      if (!thread.row["guestBookingId"]) {
        if (thread.row["sourceBookingId"] && thread.row["sourceBookingId"] !== inquiryId)
          throw new Error("system inquiry conflicts with the thread source reference");
        for (const [field, value] of Object.entries(stay)) {
          const previous = thread.row[field];
          if (previous != null && value != null && previous !== value)
            throw new Error(`system inquiry ${field} conflicts across retained messages`);
        }
        thread.row["conversationContextState"] = "inquiry";
        thread.row["sourceBookingId"] = inquiryId;
        for (const [field, value] of Object.entries(stay))
          if (value != null) thread.row[field] = value;
      }
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
    throw new Error("system inquiry dates must be an ordered pair");
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
        throw new Error(`system inquiry ${fields[0]} aliases conflict`);
      result = parsed;
    }
  }
  return result;
}

function inquiryDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("system inquiry date must be YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value)
    throw new Error("system inquiry date must be a real calendar date");
  return value;
}

function inquiryCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100)
    throw new Error("system inquiry count must be an integer from 0 through 100");
  return value;
}
