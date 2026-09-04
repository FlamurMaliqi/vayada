import { describe, expect, it, vi } from "vitest";

import { createResendPmsInboxDelivery } from "./resendPmsInboxDelivery.js";

describe("Resend PMS Inbox delivery", () => {
  it("sends direct email attachments with stable provider idempotency", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ id: "email-1" }, 200));

    await expect(provider(request).send(input())).resolves.toEqual({
      ok: true,
      providerReference: "email-1",
    });

    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(options?.headers).toMatchObject({
      Authorization: "Bearer re_test",
      "Idempotency-Key": "message:message-1",
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      from: "Vayada Stay <stay@example.test>",
      to: ["guest@example.test"],
      subject: "A message from your accommodation",
      text: "Welcome!",
      attachments: [{ filename: "guide.pdf", content: "AQI=" }],
    });
  });

  it("safely retries network errors and concurrent idempotent requests", async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout"));
    await expect(provider(network).send(input())).resolves.toEqual({
      ok: false,
      failure: "transient_provider_failure",
    });
    const concurrent = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ name: "concurrent_idempotent_requests" }, 409));
    await expect(provider(concurrent).send(input())).resolves.toEqual({
      ok: false,
      failure: "transient_provider_failure",
    });
  });

  it("holds delivery when the approved sender configuration is rejected", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ name: "invalid_from_address" }, 422));
    await expect(provider(request).send(input())).resolves.toEqual({
      ok: false,
      failure: "provider_configuration_unavailable",
    });
  });

  it.each([
    [200, {}, "ambiguous_provider_outcome"],
    [409, { name: "idempotency_key_in_use" }, "ambiguous_provider_outcome"],
  ])("holds an uncertain %s response for manual review", async (status, body, failure) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json(body, status));
    await expect(provider(request).send(input())).resolves.toEqual({ ok: false, failure });
  });

  it("rejects missing direct-email routing without calling Resend", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(provider(request).send(input({ recipientEmail: null }))).resolves.toEqual({
      ok: false,
      failure: "invalid_delivery_payload",
    });
    expect(request).not.toHaveBeenCalled();
  });
});

function provider(request: typeof fetch) {
  return createResendPmsInboxDelivery({
    apiKey: "re_test",
    from: "Vayada Stay <stay@example.test>",
    fetch: request,
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "message-1",
    providerIdempotencyReference: "message:message-1",
    channel: "email" as const,
    providerConversationId: null,
    recipientEmail: "guest@example.test",
    subject: "A message from your accommodation",
    text: "Welcome!",
    attachments: [
      { filename: "guide.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2]) },
    ],
    ...overrides,
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
