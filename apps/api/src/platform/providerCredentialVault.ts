import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

export type ProviderCredentialVault = {
  put(reference: string, value: unknown, signal?: AbortSignal): Promise<void>;
  get<T>(reference: string, signal?: AbortSignal): Promise<T | null>;
  delete(reference: string, signal?: AbortSignal): Promise<void>;
};

type SecretsManagerPort = Pick<SecretsManagerClient, "send">;

export function createSecretsManagerProviderCredentialVault(
  input: {
    client?: SecretsManagerPort;
    region?: string;
  } = {},
): ProviderCredentialVault {
  const client = input.client ?? new SecretsManagerClient({ region: input.region });

  return {
    async put(reference, value, signal) {
      const secretString = JSON.stringify(value);
      try {
        const command = new CreateSecretCommand({
          Name: reference,
          SecretString: secretString,
          Description: "Vayada creator platform OAuth grant",
        });
        await (signal ? client.send(command, { abortSignal: signal }) : client.send(command));
      } catch (error) {
        if (errorName(error) !== "ResourceExistsException") {
          throw error;
        }
        const command = new PutSecretValueCommand({
          SecretId: reference,
          SecretString: secretString,
        });
        await (signal ? client.send(command, { abortSignal: signal }) : client.send(command));
      }
    },

    async get<T>(reference: string, signal?: AbortSignal): Promise<T | null> {
      let result;
      try {
        const command = new GetSecretValueCommand({ SecretId: reference });
        result = await (signal
          ? client.send(command, { abortSignal: signal })
          : client.send(command));
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") {
          return null;
        }
        throw error;
      }
      if (!result.SecretString) return null;
      return JSON.parse(result.SecretString) as T;
    },

    async delete(reference, signal) {
      try {
        const command = new DeleteSecretCommand({
          SecretId: reference,
          ForceDeleteWithoutRecovery: true,
        });
        await (signal ? client.send(command, { abortSignal: signal }) : client.send(command));
      } catch (error) {
        if (errorName(error) !== "ResourceNotFoundException") {
          throw error;
        }
      }
    },
  };
}

export function createMemoryProviderCredentialVault(): ProviderCredentialVault {
  const credentials = new Map<string, string>();

  return {
    async put(reference, value, signal) {
      signal?.throwIfAborted();
      credentials.set(reference, JSON.stringify(value));
    },
    async get<T>(reference: string, signal?: AbortSignal): Promise<T | null> {
      signal?.throwIfAborted();
      const value = credentials.get(reference);
      return value === undefined ? null : (JSON.parse(value) as T);
    },
    async delete(reference, signal) {
      signal?.throwIfAborted();
      credentials.delete(reference);
    },
  };
}

export function createUnavailableProviderCredentialVault(): ProviderCredentialVault {
  const unavailable = (): never => {
    throw new Error("Creator platform credential vault is not configured");
  };
  return {
    async put() {
      unavailable();
    },
    async get() {
      return unavailable();
    },
    async delete() {
      unavailable();
    },
  };
}

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : undefined;
}
