import { afterEach, describe, expect, it, vi } from "vitest";

import {
  recoverUnauthorizedResponse,
  redirectToOrganizationSelection,
  type ApiSessionRecoveryHandlers,
} from "./apiSessionRecovery";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("routes organization selection through the existing login callback", () => {
  const location = {
    origin: "https://pms.localhost",
    pathname: "/calendar",
    search: "?view=year",
    hash: "#july",
    href: "",
  };
  vi.stubGlobal("window", { location });

  redirectToOrganizationSelection();

  expect(location.href).toBe(
    "https://pms.localhost/login?auth=callback&returnTo=%2Fcalendar%3Fview%3Dyear%23july",
  );
});

describe("recoverUnauthorizedResponse", () => {
  it("shares one refresh and retries concurrent requests with the new token", async () => {
    let token = "expired-token";
    const refresh = Promise.withResolvers<void>();
    const handlers: ApiSessionRecoveryHandlers = {
      refresh: vi.fn(async () => {
        await refresh.promise;
        token = "fresh-token";
      }),
      signOut: vi.fn(),
    };
    const retry = vi.fn(async () => response(200));

    const first = recoverUnauthorizedResponse({
      response: response(401),
      failedToken: token,
      getToken: () => token,
      retry,
      handlers,
    });
    const second = recoverUnauthorizedResponse({
      response: response(401),
      failedToken: token,
      getToken: () => token,
      retry,
      handlers,
    });

    await vi.waitFor(() => expect(handlers.refresh).toHaveBeenCalledOnce());
    refresh.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 200 }),
    ]);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenNthCalledWith(1, "fresh-token");
    expect(retry).toHaveBeenNthCalledWith(2, "fresh-token");
    expect(handlers.signOut).not.toHaveBeenCalled();
  });

  it("keeps a transient refresh failure retryable without signing out", async () => {
    const handlers: ApiSessionRecoveryHandlers = {
      refresh: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      signOut: vi.fn(),
    };
    const original = response(401);
    const retry = vi.fn();

    await expect(
      recoverUnauthorizedResponse({
        response: original,
        failedToken: "expired-token",
        getToken: () => "expired-token",
        retry,
        handlers,
      }),
    ).resolves.toBe(original);
    expect(retry).not.toHaveBeenCalled();
    expect(handlers.signOut).not.toHaveBeenCalled();
  });

  it("signs out when refresh succeeds without replacing the expired token", async () => {
    const handlers: ApiSessionRecoveryHandlers = {
      refresh: vi.fn(async () => undefined),
      signOut: vi.fn(),
    };
    const original = response(401);
    const retry = vi.fn();

    await expect(
      recoverUnauthorizedResponse({
        response: original,
        failedToken: "expired-token",
        getToken: () => "expired-token",
        retry,
        handlers,
      }),
    ).resolves.toBe(original);
    expect(retry).not.toHaveBeenCalled();
    expect(handlers.signOut).toHaveBeenCalledOnce();
  });

  it("routes organization selection without signing out its pending session", async () => {
    let token: string | null = "expired-token";
    const handlers: ApiSessionRecoveryHandlers = {
      refresh: vi.fn(async () => {
        token = null;
        return { status: "organization_selection_required" } as const;
      }),
      onOrganizationSelectionRequired: vi.fn(),
      signOut: vi.fn(),
    };
    const original = response(401);
    const retry = vi.fn();

    await expect(
      recoverUnauthorizedResponse({
        response: original,
        failedToken: "expired-token",
        getToken: () => token,
        retry,
        handlers,
      }),
    ).resolves.toBe(original);
    expect(retry).not.toHaveBeenCalled();
    expect(handlers.onOrganizationSelectionRequired).toHaveBeenCalledOnce();
    expect(handlers.signOut).not.toHaveBeenCalled();
  });

  it("signs out when the refresh endpoint definitively rejects the session", async () => {
    const handlers: ApiSessionRecoveryHandlers = {
      refresh: vi.fn(async () => {
        throw Object.assign(new Error("invalid session"), { status: 401 });
      }),
      signOut: vi.fn(),
    };
    const original = response(401);
    const retry = vi.fn();

    await expect(
      recoverUnauthorizedResponse({
        response: original,
        failedToken: "expired-token",
        getToken: () => "expired-token",
        retry,
        handlers,
      }),
    ).resolves.toBe(original);
    expect(retry).not.toHaveBeenCalled();
    expect(handlers.signOut).toHaveBeenCalledOnce();
  });

  it("stops after one retry when the refreshed token is rejected", async () => {
    let token = "expired-token";
    const handlers: ApiSessionRecoveryHandlers = {
      refresh: vi.fn(async () => {
        token = "fresh-token";
      }),
      signOut: vi.fn(),
    };
    const retry = vi.fn(async () => response(401));

    await expect(
      recoverUnauthorizedResponse({
        response: response(401),
        failedToken: token,
        getToken: () => token,
        retry,
        handlers,
      }),
    ).resolves.toMatchObject({ status: 401 });
    expect(retry).toHaveBeenCalledOnce();
    expect(handlers.signOut).toHaveBeenCalledOnce();
  });
});

function response(status: number): Response {
  return new Response(status === 204 ? null : "{}", {
    status,
    headers: { "content-type": "application/json" },
  });
}
