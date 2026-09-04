import type {
  PmsInboxDeliveryAttachmentContent,
  PmsInboxDeliveryProvider,
  PmsInboxDeliveryProviderResult,
} from "../domains/pmsInboxDelivery.js";

export function createChannexMessageDelivery(config: {
  apiBaseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  deliveryTimeoutMs?: number;
}): PmsInboxDeliveryProvider {
  const baseUrl = new URL(config.apiBaseUrl);
  const request = config.fetch ?? fetch;
  return {
    async send(input) {
      const deliverySignal = AbortSignal.timeout(config.deliveryTimeoutMs ?? 4 * 60_000);
      if (
        input.channel !== "ota" ||
        !input.providerConversationId?.trim() ||
        (!input.text.trim() && input.attachments.length === 0)
      )
        return { ok: false, failure: "invalid_delivery_payload" };

      const attachmentIds: string[] = [];
      for (const attachment of input.attachments) {
        const uploaded = await uploadAttachment(
          request,
          baseUrl,
          config.apiKey,
          attachment,
          deliverySignal,
        );
        if (!uploaded.ok) return uploaded;
        attachmentIds.push(uploaded.providerReference);
      }

      const references: string[] = [];
      const messages = attachmentIds.length ? attachmentIds : [null];
      for (const [index, attachmentId] of messages.entries()) {
        const sent = await postMessage(
          request,
          baseUrl,
          config.apiKey,
          {
            conversationId: input.providerConversationId,
            text: index === 0 ? input.text.trim() : "",
            attachmentId,
          },
          deliverySignal,
        );
        if (!sent.ok)
          return references.length
            ? {
                ok: false,
                failure: "ambiguous_provider_outcome",
                acceptedProviderReferences: references,
              }
            : sent;
        references.push(sent.providerReference);
      }
      return { ok: true, providerReference: references.join(",") };
    },
  };
}

async function uploadAttachment(
  request: typeof fetch,
  baseUrl: URL,
  apiKey: string,
  attachment: PmsInboxDeliveryAttachmentContent,
  deliverySignal: AbortSignal,
): Promise<PmsInboxDeliveryProviderResult> {
  if (!attachment.filename.trim() || !attachment.contentType.trim() || !attachment.bytes.length)
    return { ok: false, failure: "invalid_delivery_payload" };
  return providerRequest(
    request,
    baseUrl,
    apiKey,
    "/api/v1/attachments",
    {
      attachment: {
        file: Buffer.from(attachment.bytes).toString("base64"),
        file_name: attachment.filename,
        file_type: attachment.contentType,
      },
    },
    "upload",
    deliverySignal,
  );
}

async function postMessage(
  request: typeof fetch,
  baseUrl: URL,
  apiKey: string,
  input: { conversationId: string; text: string; attachmentId: string | null },
  deliverySignal: AbortSignal,
): Promise<PmsInboxDeliveryProviderResult> {
  const message = {
    ...(input.text ? { message: input.text } : {}),
    ...(input.attachmentId ? { attachment_id: input.attachmentId } : {}),
  };
  return providerRequest(
    request,
    baseUrl,
    apiKey,
    `/api/v1/message_threads/${encodeURIComponent(input.conversationId)}/messages`,
    { message },
    "send",
    deliverySignal,
  );
}

async function providerRequest(
  request: typeof fetch,
  baseUrl: URL,
  apiKey: string,
  path: string,
  body: unknown,
  operation: "upload" | "send",
  deliverySignal: AbortSignal,
): Promise<PmsInboxDeliveryProviderResult> {
  let response: Response;
  try {
    response = await request(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "user-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.any([deliverySignal, AbortSignal.timeout(30_000)]),
    });
  } catch {
    return {
      ok: false,
      failure: operation === "send" ? "ambiguous_provider_outcome" : "transient_provider_failure",
    };
  }
  const providerRequestId = response.headers.get("x-request-id") ?? undefined;
  if (!response.ok) {
    const failure =
      response.status === 429 || response.status >= 500
        ? "transient_provider_failure"
        : response.status === 401 || response.status === 403
          ? "provider_configuration_unavailable"
          : operation === "upload" && [400, 413, 415, 422].includes(response.status)
            ? "invalid_delivery_payload"
            : "provider_rejected";
    return { ok: false, failure, ...(providerRequestId ? { providerRequestId } : {}) };
  }
  const providerReference = responseId(await response.json().catch(() => null));
  return providerReference
    ? { ok: true, providerReference }
    : {
        ok: false,
        failure: operation === "send" ? "ambiguous_provider_outcome" : "provider_rejected",
        ...(providerRequestId ? { providerRequestId } : {}),
      };
}

function responseId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const data = "data" in value ? value.data : value;
  if (!data || typeof data !== "object" || !("id" in data)) return null;
  return typeof data.id === "string" && data.id.trim() ? data.id.trim() : null;
}
