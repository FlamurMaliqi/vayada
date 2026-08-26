export const FINANCE_FOLIO_RECIPIENT_ENCRYPTION_SCHEME = "envelope_aead_v1" as const;
export const FINANCE_FOLIO_RECIPIENT_PURPOSE = "finance-folio-recipient-v1" as const;

export type FinanceFolioRecipientDecoderInput = {
  propertyId: string;
  folioId: string;
  revision: number;
  ciphertext: Buffer;
  encryptionScheme: typeof FINANCE_FOLIO_RECIPIENT_ENCRYPTION_SCHEME;
  keyVersion: string;
};

export type FinanceFolioRecipientDecoder = {
  decode(input: FinanceFolioRecipientDecoderInput): Promise<unknown>;
};

/** Port shaped like AWS KMS Decrypt without coupling the domain to the AWS SDK. */
export type FinanceFolioKmsDecryptPort = {
  decrypt(input: {
    CiphertextBlob: Uint8Array;
    KeyId: string;
    EncryptionContext: Readonly<Record<string, string>>;
  }): Promise<{ Plaintext?: Uint8Array; KeyId?: string }>;
};

export class FinanceFolioRecipientCodecError extends Error {
  readonly code = "recipient_evidence_unavailable";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KMS_KEY_ARN = /^arn:[a-z0-9-]+:kms:[a-z0-9-]+:\d{12}:key\/[a-z0-9-]+$/;
const MIN_CIPHERTEXT_BYTES = 29; // Shared app/database envelope floor, not a KMS limit.
const MAX_CIPHERTEXT_BYTES = 6_144;
const MAX_PLAINTEXT_BYTES = 4_096;

export function createKmsFinanceFolioRecipientDecoder(config: {
  kms: FinanceFolioKmsDecryptPort;
  allowedKeyArns: readonly string[];
}): FinanceFolioRecipientDecoder {
  if (!config?.kms || typeof config.kms.decrypt !== "function") fail();
  const allowedKeyArns = new Set(config.allowedKeyArns);
  if (!allowedKeyArns.size || [...allowedKeyArns].some((value) => !keyArn(value))) fail();

  return {
    async decode(input) {
      try {
        if (
          input.encryptionScheme !== FINANCE_FOLIO_RECIPIENT_ENCRYPTION_SCHEME ||
          !uuid(input.propertyId) ||
          !uuid(input.folioId) ||
          !Number.isSafeInteger(input.revision) ||
          input.revision < 1 ||
          !Buffer.isBuffer(input.ciphertext) ||
          input.ciphertext.length < MIN_CIPHERTEXT_BYTES ||
          input.ciphertext.length > MAX_CIPHERTEXT_BYTES ||
          !allowedKeyArns.has(input.keyVersion)
        )
          fail();
        const result = await config.kms.decrypt({
          CiphertextBlob: input.ciphertext,
          KeyId: input.keyVersion,
          EncryptionContext: {
            purpose: FINANCE_FOLIO_RECIPIENT_PURPOSE,
            propertyId: input.propertyId,
            folioId: input.folioId,
            revision: String(input.revision),
          },
        });
        if (!(result.Plaintext instanceof Uint8Array) || result.KeyId !== input.keyVersion) fail();
        return recipient(Buffer.from(result.Plaintext));
      } catch {
        fail();
      }
    },
  };
}

function recipient(bytes: Buffer): { name: string; email: string | null } {
  if (!bytes.length || bytes.length > MAX_PLAINTEXT_BYTES) fail();
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!exact(value, ["v", "name", "email"]) || value.v !== 1 || !trimmed(value.name)) fail();
  if (value.email !== null && (!trimmed(value.email) || !value.email.includes("@"))) fail();
  const canonical = Buffer.from(JSON.stringify({ v: 1, name: value.name, email: value.email }));
  if (!canonical.equals(bytes)) fail();
  return { name: value.name, email: value.email };
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function keyArn(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && KMS_KEY_ARN.test(value);
}

function trimmed(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function fail(): never {
  throw new FinanceFolioRecipientCodecError("Finance folio recipient evidence is unavailable");
}
