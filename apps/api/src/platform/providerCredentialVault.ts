import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

export type ProviderCredentialVault = {
  put(reference: string, value: unknown): Promise<void>;
  get<T>(reference: string): Promise<T | null>;
  delete(reference: string): Promise<void>;
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
    async put(reference, value) {
      const secretString = JSON.stringify(value);
      try {
        await client.send(
          new CreateSecretCommand({
            Name: reference,
            SecretString: secretString,
            Description: "Vayada creator platform OAuth grant",
          }),
        );
      } catch (error) {
        if (errorName(error) !== "ResourceExistsException") {
          throw error;
        }
        await client.send(
          new PutSecretValueCommand({
            SecretId: reference,
            SecretString: secretString,
          }),
        );
      }
    },

    async get<T>(reference: string): Promise<T | null> {
      let result;
      try {
        result = await client.send(new GetSecretValueCommand({ SecretId: reference }));
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") {
          return null;
        }
        throw error;
      }
      if (!result.SecretString) return null;
      return JSON.parse(result.SecretString) as T;
    },

    async delete(reference) {
      try {
        await client.send(
          new DeleteSecretCommand({
            SecretId: reference,
            ForceDeleteWithoutRecovery: true,
          }),
        );
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
    async put(reference, value) {
      credentials.set(reference, JSON.stringify(value));
    },
    async get<T>(reference: string): Promise<T | null> {
      const value = credentials.get(reference);
      return value === undefined ? null : (JSON.parse(value) as T);
    },
    async delete(reference) {
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
