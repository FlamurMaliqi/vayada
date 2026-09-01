import {
  ResourceExistsException,
  ResourceNotFoundException,
} from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";

import {
  createMemoryProviderCredentialVault,
  createSecretsManagerProviderCredentialVault,
  createUnavailableProviderCredentialVault,
} from "./platform/providerCredentialVault.js";

describe("provider credential vault", () => {
  it("keeps local credentials behind opaque references", async () => {
    const vault = createMemoryProviderCredentialVault();

    await vault.put("provider/ref", { accessToken: "secret" });

    expect(await vault.get("provider/ref")).toEqual({ accessToken: "secret" });
    await vault.delete("provider/ref");
    expect(await vault.get("provider/ref")).toBeNull();
  });

  it("fails closed when credential storage is not configured", async () => {
    const vault = createUnavailableProviderCredentialVault();

    await expect(vault.get("provider/ref")).rejects.toThrow("not configured");
    await expect(vault.delete("provider/ref")).rejects.toThrow("not configured");
  });

  it("creates and reads AWS Secrets Manager values", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ SecretString: '{"accessToken":"secret"}' });
    const vault = createSecretsManagerProviderCredentialVault({ client: { send } as never });

    await vault.put("provider/ref", { accessToken: "secret" });

    expect(await vault.get("provider/ref")).toEqual({ accessToken: "secret" });
    expect(send.mock.calls[0][0].input).toMatchObject({
      Name: "provider/ref",
      SecretString: '{"accessToken":"secret"}',
    });
  });

  it("adds a new secret version when the reference already exists", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        new ResourceExistsException({ $metadata: {}, message: "already exists" }),
      )
      .mockResolvedValueOnce({});
    const vault = createSecretsManagerProviderCredentialVault({ client: { send } as never });

    await vault.put("provider/ref", { refreshToken: "rotated" });

    expect(send.mock.calls[1][0].input).toEqual({
      SecretId: "provider/ref",
      SecretString: '{"refreshToken":"rotated"}',
    });
  });

  it("treats an already removed AWS secret as absent", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ResourceNotFoundException({ $metadata: {}, message: "not found" }));
    const vault = createSecretsManagerProviderCredentialVault({ client: { send } as never });

    expect(await vault.get("provider/missing")).toBeNull();
    await expect(vault.delete("provider/missing")).resolves.toBeUndefined();
  });

  it("passes worker cancellation to AWS Secrets Manager", async () => {
    const send = vi.fn().mockResolvedValue({ SecretString: '{"provider":"instagram"}' });
    const vault = createSecretsManagerProviderCredentialVault({ client: { send } as never });
    const controller = new AbortController();

    await vault.get("provider/ref", controller.signal);

    expect(send.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });
  });
});
