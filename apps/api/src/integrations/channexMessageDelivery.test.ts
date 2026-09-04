import { describe, expect, it, vi } from "vitest";

import { createChannexMessageDelivery } from "./channexMessageDelivery.js";

describe("Channex guest-message delivery", () => {
  it("uploads attachments and sends one Channex message per attachment", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json("attachment-1"))
      .mockResolvedValueOnce(json("attachment-2"))
      .mockResolvedValueOnce(json("message-1"))
      .mockResolvedValueOnce(json("message-2"));

    await expect(provider(request).send(input())).resolves.toEqual({
      ok: true,
      providerReference: "message-1,message-2",
    });

    expect(request).toHaveBeenCalledTimes(4);
    expect(String(request.mock.calls[0]![0])).toBe("https://channex.test/api/v1/attachments");
    expect(JSON.parse(String(request.mock.calls[2]![1]?.body))).toEqual({
      message: { message: "Welcome!", attachment_id: "attachment-1" },
    });
    expect(JSON.parse(String(request.mock.calls[3]![1]?.body))).toEqual({
      message: { attachment_id: "attachment-2" },
    });
  });

  it("holds an ambiguous response timeout instead of blindly retrying", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("response timeout"));
    await expect(provider(request).send(input({ attachments: [] }))).resolves.toEqual({
      ok: false,
      failure: "ambiguous_provider_outcome",
    });
  });

  it("retries an explicit provider outage before any message was accepted", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
    await expect(provider(request).send(input({ attachments: [] }))).resolves.toEqual({
      ok: false,
      failure: "transient_provider_failure",
    });
  });

  it("holds a partial multi-message delivery for manual review", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json("attachment-1"))
      .mockResolvedValueOnce(json("attachment-2"))
      .mockResolvedValueOnce(json("message-1"))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(provider(request).send(input())).resolves.toEqual({
      ok: false,
      failure: "ambiguous_provider_outcome",
      acceptedProviderReferences: ["message-1"],
    });
  });

  it.each([
    [200, "ambiguous_provider_outcome"],
    [401, "provider_configuration_unavailable"],
  ])("classifies a %s send without pretending it is safe to resend", async (status, failure) => {
    const response =
      status === 200 ? new Response("not-json", { status }) : new Response("", { status });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(provider(request).send(input({ attachments: [] }))).resolves.toEqual({
      ok: false,
      failure,
    });
  });

  it("bounds the complete multipart operation below the delivery lease", async () => {
    const request = vi.fn<typeof fetch>(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("deadline")));
        }),
    );
    const bounded = createChannexMessageDelivery({
      apiBaseUrl: "https://channex.test",
      apiKey: "secret",
      fetch: request,
      deliveryTimeoutMs: 5,
    });
    await expect(bounded.send(input())).resolves.toEqual({
      ok: false,
      failure: "transient_provider_failure",
    });
    expect(request).toHaveBeenCalledOnce();
  });
});

function provider(request: typeof fetch) {
  return createChannexMessageDelivery({
    apiBaseUrl: "https://channex.test",
    apiKey: "secret",
    fetch: request,
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "message-1",
    providerIdempotencyReference: "message:message-1",
    channel: "ota" as const,
    providerConversationId: "conversation/1",
    recipientEmail: null,
    senderEmail: null,
    subject: "Guest message",
    text: "Welcome!",
    attachments: [
      { filename: "one.jpg", contentType: "image/jpeg", bytes: new Uint8Array([1]) },
      { filename: "two.pdf", contentType: "application/pdf", bytes: new Uint8Array([2]) },
    ],
    ...overrides,
  };
}

function json(id: string): Response {
  return new Response(JSON.stringify({ data: { id } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
