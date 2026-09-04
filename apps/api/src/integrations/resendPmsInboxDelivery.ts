import type {
  PmsInboxDeliveryProvider,
  PmsInboxDeliveryProviderResult,
} from "../domains/pmsInboxDelivery.js";

export function createResendPmsInboxDelivery(config: {
  apiKey: string;
  fetch?: typeof fetch;
}): PmsInboxDeliveryProvider {
  const request = config.fetch ?? fetch;
  return {
    async send(input) {
      if (
        input.channel !== "email" ||
        !input.recipientEmail?.trim() ||
        !input.senderEmail?.trim() ||
        !input.subject.trim() ||
        (!input.text.trim() && input.attachments.length === 0) ||
        !input.providerIdempotencyReference.trim() ||
        input.providerIdempotencyReference.length > 256
      )
        return { ok: false, failure: "invalid_delivery_payload" };

      let response: Response;
      try {
        response = await request("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": input.providerIdempotencyReference,
          },
          body: JSON.stringify({
            from: input.senderEmail.trim(),
            to: [input.recipientEmail.trim()],
            subject: input.subject.trim(),
            text: input.text,
            attachments: input.attachments.map((attachment) => ({
              filename: attachment.filename,
              content: Buffer.from(attachment.bytes).toString("base64"),
            })),
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        return { ok: false, failure: "transient_provider_failure" };
      }

      const body = await response.json().catch(() => null);
      if (!response.ok) return failure(response, body);
      const providerReference = responseId(body);
      return providerReference
        ? { ok: true, providerReference }
        : { ok: false, failure: "ambiguous_provider_outcome" };
    },
  };
}

function failure(response: Response, body: unknown): PmsInboxDeliveryProviderResult {
  const providerRequestId = response.headers.get("x-request-id") ?? undefined;
  const name = errorName(body);
  const failure =
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 409 && name === "concurrent_idempotent_requests")
      ? "transient_provider_failure"
      : response.status === 409
        ? "ambiguous_provider_outcome"
        : response.status === 401 || response.status === 403 || name === "invalid_from_address"
          ? "provider_configuration_unavailable"
          : [400, 413, 422].includes(response.status)
            ? "invalid_delivery_payload"
            : "provider_rejected";
  return { ok: false as const, failure, ...(providerRequestId ? { providerRequestId } : {}) };
}

function responseId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("id" in value)) return null;
  return typeof value.id === "string" && value.id.trim() ? value.id.trim() : null;
}

function errorName(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("name" in value)) return null;
  return typeof value.name === "string" ? value.name : null;
}
