import { ApiErrorResponse } from "../api/client";
import { pmsOperationsClient, pmsOperationsRequestOptions } from "../api/pmsOperationsClient";

export const INBOX_CONTRACT_VERSION = "native-guest-inbox.v2" as const;

export type InboxAttentionState = "needs_attention" | "follow_up" | "done";
export type InboxChannel = "ota" | "email";
export type InboxDeliveryState = "queued" | "retrying" | "sent" | "held" | "failed";

export type InboxReplyRoute =
  | {
      state: "ready";
      channel: InboxChannel;
      providerChannel: string | null;
      reasonCode: null;
    }
  | {
      state: "held";
      channel: null;
      providerChannel: string | null;
      reasonCode:
        | "channel_connection_inactive"
        | "provider_conversation_unavailable"
        | "guest_email_unavailable"
        | "approved_sender_unavailable"
        | "email_policy_disallowed";
    };

export type InboxConversationContext =
  | {
      state: "linked";
      bookingId: string;
      reference: string;
      stay: {
        checkIn: string;
        checkOut: string;
        nights: number;
        adults: number;
        children: number;
        roomCount: number;
        roomName: string | null;
        roomNumber: string | null;
        status: string;
      };
    }
  | {
      state: "inquiry";
      bookingId: null;
      sourceReference: string;
      arrivalDate: string | null;
      departureDate: string | null;
      adults: number | null;
      children: number | null;
    }
  | { state: "unlinked"; bookingId: null; sourceReference: string | null };

export type InboxThread = {
  id: string;
  version: number;
  attentionState: InboxAttentionState;
  followUpAt: string | null;
  assignedTo: null | { membershipId: string; displayName: string };
  channel: InboxChannel;
  providerChannel: string | null;
  guest: { displayName: string | null; email?: string; phone?: string };
  conversationContext: InboxConversationContext;
  unreadCount: number;
  activityAt: string;
  lastMessage: { preview: string | null; at: string | null; hasAttachments: boolean };
  replyRoute: InboxReplyRoute;
};

export type InboxAttachment =
  | {
      id: string;
      availability: "available";
      mediaId: string;
      filename: string;
      contentType: string;
      size: number;
      accessPath: string;
    }
  | {
      id: string;
      availability: "unavailable";
      mediaId: string | null;
      filename: string | null;
      contentType: string | null;
      size: number | null;
      accessPath: null;
    };

export type InboxMessage = {
  id: string;
  direction: "inbound" | "outbound";
  sender: { type: "guest" | "property_user" | "channel" | "system"; name: string | null };
  text: string | null;
  occurredAt: string;
  readAt: string | null;
  attachments: InboxAttachment[];
  delivery: null | {
    state: InboxDeliveryState;
    channel: InboxChannel | null;
    reasonCode: string | null;
    providerAcknowledgedAt: string | null;
  };
};

export type InboxInternalNote = {
  id: string;
  author: { membershipId: string; displayName: string };
  text: string;
  occurredAt: string;
};

export type InboxTimelineItem =
  | { kind: "message"; message: InboxMessage }
  | { kind: "internal_note"; note: InboxInternalNote };

export type InboxListFilters = {
  attentionState: InboxAttentionState;
  unread?: boolean;
  channel?: InboxChannel;
  assignee?: "me" | "unassigned" | string;
  search?: string;
  limit?: number;
  cursor?: string;
};

export type InboxThreadListResponse = {
  contractVersion: typeof INBOX_CONTRACT_VERSION;
  items: InboxThread[];
  nextCursor: string | null;
};

export type InboxThreadDetailResponse = {
  contractVersion: typeof INBOX_CONTRACT_VERSION;
  thread: InboxThread;
  availableProviderActions: Array<"booking_com_no_reply_needed">;
  timeline: InboxTimelineItem[];
  previousCursor: string | null;
};

export type InboxUnreadCountResponse = {
  contractVersion: typeof INBOX_CONTRACT_VERSION;
  propertyId: string;
  threadCount: number;
  messageCount: number;
};

export type InboxQuickReply = {
  id: string;
  name: string;
  text: string;
  approvedVariables: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type InboxAssistanceKind =
  | "translate_message"
  | "translate_draft"
  | "summarize"
  | "draft_reply";

export type InboxAssistanceResponse = {
  contractVersion: typeof INBOX_CONTRACT_VERSION;
  propertyId: string;
  threadId: string;
  kind: InboxAssistanceKind;
  assistedText: string;
  attribution: "ai_assisted";
  reviewRequired: true;
  basedThroughMessageId: string | null;
};

export type InboxDirectBooking = {
  guestBookingId: string;
  bookingReference: string;
  source: "direct_booking" | "channel" | "manual" | "migration";
  status: string;
  primaryGuest: { displayName: string };
  stay: { checkIn: string; checkOut: string };
};

type ContractResponse<T> = T & { contractVersion: typeof INBOX_CONTRACT_VERSION };

function endpoint(propertyId: string, suffix: string): string {
  return `/api/pms/properties/${encodeURIComponent(propertyId)}/messaging/${suffix}`;
}

function commandOptions(idempotencyKey: string): RequestInit {
  return {
    ...pmsOperationsRequestOptions,
    headers: {
      ...(pmsOperationsRequestOptions.headers as Record<string, string>),
      "Idempotency-Key": idempotencyKey,
    },
  };
}

export function createInboxCommandKey(operation: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `pms-inbox:${operation}:${random}`;
}

const pendingTransportCommands = new Map<
  string,
  { serializedBody: string; idempotencyKey: string }
>();

async function postCommand<T>(operation: string, path: string, body: unknown): Promise<T> {
  const serializedBody = JSON.stringify(body);
  const pending = pendingTransportCommands.get(`${operation}:${path}`);
  const idempotencyKey =
    pending?.serializedBody === serializedBody
      ? pending.idempotencyKey
      : createInboxCommandKey(operation);
  const scope = `${operation}:${path}`;
  pendingTransportCommands.set(scope, { serializedBody, idempotencyKey });
  try {
    const result = await pmsOperationsClient.post<T>(path, body, commandOptions(idempotencyKey));
    if (pendingTransportCommands.get(scope)?.idempotencyKey === idempotencyKey) {
      pendingTransportCommands.delete(scope);
    }
    return result;
  } catch (error) {
    if (
      error instanceof ApiErrorResponse &&
      pendingTransportCommands.get(scope)?.idempotencyKey === idempotencyKey
    ) {
      pendingTransportCommands.delete(scope);
    }
    throw error;
  }
}

export function inboxError(error: unknown): {
  status: number | null;
  code: string | null;
  message: string;
  requestId: string | null;
} {
  if (!(error instanceof ApiErrorResponse)) {
    return {
      status: null,
      code: null,
      message: error instanceof Error ? error.message : "The Inbox is unavailable.",
      requestId: null,
    };
  }
  const data = error.data as unknown as {
    code?: string;
    message?: string;
    error?: { code?: string; message?: string; requestId?: string };
  };
  return {
    status: error.status,
    code: data.error?.code ?? data.code ?? null,
    message: data.error?.message ?? data.message ?? error.message,
    requestId: data.error?.requestId ?? null,
  };
}

export const messagingService = {
  unreadCount(propertyId: string) {
    return pmsOperationsClient.get<InboxUnreadCountResponse>(
      endpoint(propertyId, "unread-count"),
      pmsOperationsRequestOptions,
    );
  },

  listThreads(propertyId: string, filters: InboxListFilters) {
    const query = new URLSearchParams({
      attentionState: filters.attentionState,
      limit: String(filters.limit ?? 25),
    });
    if (filters.unread) query.set("unread", "true");
    if (filters.channel) query.set("channel", filters.channel);
    if (filters.assignee) query.set("assignee", filters.assignee);
    if (filters.search?.trim()) query.set("search", filters.search.trim());
    if (filters.cursor) query.set("cursor", filters.cursor);
    return pmsOperationsClient.get<InboxThreadListResponse>(
      `${endpoint(propertyId, "threads")}?${query}`,
      pmsOperationsRequestOptions,
    );
  },

  getThread(propertyId: string, threadId: string, before?: string) {
    const query = new URLSearchParams({ messageLimit: "50" });
    if (before) query.set("before", before);
    return pmsOperationsClient.get<InboxThreadDetailResponse>(
      `${endpoint(propertyId, `threads/${encodeURIComponent(threadId)}`)}?${query}`,
      pmsOperationsRequestOptions,
    );
  },

  markRead(propertyId: string, threadId: string, readThroughMessageId: string) {
    return postCommand<
      ContractResponse<{ propertyId: string; threadId: string; unreadCount: number }>
    >("mark-read", endpoint(propertyId, `threads/${encodeURIComponent(threadId)}/read`), {
      readThroughMessageId,
    });
  },

  triage(
    propertyId: string,
    threadId: string,
    action: "done" | "follow-up" | "reopen",
    expectedThreadVersion: number,
    followUpAt?: string,
  ) {
    return postCommand<
      ContractResponse<{
        propertyId: string;
        threadId: string;
        attentionState: InboxAttentionState;
        followUpAt: string | null;
        threadVersion: number;
      }>
    >(action, endpoint(propertyId, `threads/${encodeURIComponent(threadId)}/${action}`), {
      expectedThreadVersion,
      ...(followUpAt ? { followUpAt } : {}),
    });
  },

  assign(
    propertyId: string,
    threadId: string,
    expectedThreadVersion: number,
    assigneeMembershipId: string | null,
  ) {
    return postCommand<
      ContractResponse<{
        propertyId: string;
        threadId: string;
        assignedTo: InboxThread["assignedTo"];
        threadVersion: number;
      }>
    >("assign", endpoint(propertyId, `threads/${encodeURIComponent(threadId)}/assignment`), {
      expectedThreadVersion,
      assigneeMembershipId,
    });
  },

  addNote(propertyId: string, threadId: string, expectedThreadVersion: number, text: string) {
    return postCommand<
      ContractResponse<{
        propertyId: string;
        threadId: string;
        note: InboxInternalNote;
        threadVersion: number;
      }>
    >("add-note", endpoint(propertyId, `threads/${encodeURIComponent(threadId)}/notes`), {
      expectedThreadVersion,
      text,
    });
  },

  reply(
    propertyId: string,
    threadId: string,
    input: { expectedThreadVersion: number; text: string | null; attachmentMediaIds: string[] },
  ) {
    return postCommand<
      ContractResponse<{
        propertyId: string;
        threadId: string;
        messageId: string;
        threadVersion: number;
        delivery: NonNullable<InboxMessage["delivery"]>;
        acceptedAt: string;
      }>
    >("reply", endpoint(propertyId, `threads/${encodeURIComponent(threadId)}/messages`), input);
  },

  providerNoReplyNeeded(propertyId: string, threadId: string) {
    return postCommand<
      ContractResponse<{ propertyId: string; threadId: string; acceptedAt: string }>
    >(
      "provider-no-reply-needed",
      endpoint(
        propertyId,
        `threads/${encodeURIComponent(threadId)}/provider-actions/no-reply-needed`,
      ),
      {},
    );
  },

  getQuickReplies(propertyId: string) {
    return pmsOperationsClient.get<
      ContractResponse<{ propertyId: string; items: InboxQuickReply[] }>
    >(endpoint(propertyId, "quick-replies"), pmsOperationsRequestOptions);
  },

  createQuickReply(
    propertyId: string,
    input: { name: string; text: string; approvedVariables: string[] },
  ) {
    return postCommand<ContractResponse<{ propertyId: string; quickReply: InboxQuickReply }>>(
      "quick-reply-create",
      endpoint(propertyId, "quick-replies"),
      input,
    );
  },

  updateQuickReply(propertyId: string, quickReply: InboxQuickReply) {
    return postCommand<ContractResponse<{ propertyId: string; quickReply: InboxQuickReply }>>(
      "quick-reply-update",
      endpoint(propertyId, `quick-replies/${encodeURIComponent(quickReply.id)}/update`),
      {
        expectedVersion: quickReply.version,
        name: quickReply.name,
        text: quickReply.text,
        approvedVariables: quickReply.approvedVariables,
      },
    );
  },

  archiveQuickReply(propertyId: string, quickReply: InboxQuickReply) {
    return postCommand<
      ContractResponse<{ propertyId: string; quickReplyId: string; version: number }>
    >(
      "quick-reply-archive",
      endpoint(propertyId, `quick-replies/${encodeURIComponent(quickReply.id)}/archive`),
      { expectedVersion: quickReply.version },
    );
  },

  previewQuickReply(propertyId: string, threadId: string, quickReplyId: string) {
    return postCommand<
      ContractResponse<{
        propertyId: string;
        threadId: string;
        quickReplyId: string;
        renderedText: string;
        unresolvedVariables: string[];
        composerUseAllowed: boolean;
      }>
    >(
      "quick-reply-preview",
      endpoint(propertyId, `quick-replies/${encodeURIComponent(quickReplyId)}/preview`),
      { threadId },
    );
  },

  assist(
    propertyId: string,
    threadId: string,
    input:
      | {
          kind: "translate_message" | "translate_draft";
          sourceText: string;
          targetLanguage: string;
        }
      | { kind: "summarize" | "draft_reply"; throughMessageId: string },
  ) {
    return postCommand<InboxAssistanceResponse>(
      `assist-${input.kind}`,
      endpoint(propertyId, `threads/${encodeURIComponent(threadId)}/assist`),
      input,
    );
  },

  async listDirectBookings(propertyId: string): Promise<InboxDirectBooking[]> {
    const response = await pmsOperationsClient.get<{
      contractVersion: typeof INBOX_CONTRACT_VERSION;
      propertyId: string;
      items: InboxDirectBooking[];
    }>(endpoint(propertyId, "direct-bookings"), pmsOperationsRequestOptions);
    return response.items;
  },

  startDirectEmail(propertyId: string, bookingId: string) {
    return postCommand<
      ContractResponse<{
        propertyId: string;
        bookingId: string;
        created: boolean;
        thread: {
          id: string;
          attentionState: InboxAttentionState;
          channel: "email";
          version: number;
          activityAt: string;
          replyRoute: InboxReplyRoute;
        };
      }>
    >("start-direct-email", endpoint(propertyId, "threads"), { bookingId });
  },
};
