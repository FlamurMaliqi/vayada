import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "./client";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ApiClient request logging", () => {
  it("does not declare JSON for a bodyless delete", async () => {
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await new ApiClient("https://api.example.test").delete("/offers/offer-one");

    expect(fetchMock).toHaveBeenCalledOnce();
    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.body).toBeUndefined();
    expect(new Headers(options?.headers).get("Content-Type")).toBeNull();
  });

  it("does not log a caller-initiated abort as an API failure", async () => {
    const controller = new AbortController();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }),
    );

    const request = new ApiClient("https://api.example.test").get("/status", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("still logs an unexpected network failure", async () => {
    const error = new TypeError("Failed to fetch");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

    await expect(new ApiClient("https://api.example.test").get("/status")).rejects.toBe(error);
    expect(errorSpy).toHaveBeenCalledWith("API request failed:", error);
  });
});
