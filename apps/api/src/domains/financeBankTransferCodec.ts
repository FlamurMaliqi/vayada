import { z } from "zod";
import type {
  FinanceFolioKmsDecryptPort,
  FinanceFolioKmsWritePort,
} from "./financeFolioRecipientCodec.js";

const field = (max: number) => z.string().trim().min(1).max(max);
export const bankTransferDetailsSchema = z.strictObject({
  accountHolder: field(200),
  accountType: z.enum(["iban", "account_number"]),
  accountNumber: field(64)
    .regex(/^[A-Za-z0-9 -]+$/)
    .refine((value) => value.replace(/[ -]/g, "").length >= 8),
  bankName: field(200),
  bicSwift: z.string().trim().max(32),
  instructions: z.string().trim().max(1000),
});
export type BankTransferDetails = z.infer<typeof bankTransferDetailsSchema>;
type Scope = { propertyId: string; id: string; revision: number };
const scopeSchema = z.object({ propertyId: z.uuid(), id: z.uuid(), revision: z.int().positive() });
const arnSchema = z.string().regex(/^arn:[a-z0-9-]+:kms:[a-z0-9-]+:\d{12}:key\/[a-z0-9-]+$/);
const unavailable = () => new Error("Bank transfer destination unavailable.");

export function createBankTransferCodec(config: {
  kms: Pick<FinanceFolioKmsWritePort, "encrypt"> & FinanceFolioKmsDecryptPort;
  currentKeyArn: string;
  allowedKeyArns: readonly string[];
}) {
  if (
    !arnSchema.safeParse(config.currentKeyArn).success ||
    !config.allowedKeyArns.includes(config.currentKeyArn) ||
    config.allowedKeyArns.some((arn) => !arnSchema.safeParse(arn).success)
  )
    throw unavailable();
  function context(scope: Scope) {
    const parsed = scopeSchema.parse(scope);
    return {
      purpose: "finance-bank-transfer-v1",
      propertyId: parsed.propertyId,
      destinationId: parsed.id,
      revision: String(parsed.revision),
    };
  }
  return {
    async encrypt(scope: Scope, input: unknown) {
      try {
        const details = bankTransferDetailsSchema.parse(input);
        const plaintext = Buffer.from(JSON.stringify(details));
        if (plaintext.length > 4096) throw unavailable();
        const result = await config.kms.encrypt({
          Plaintext: plaintext,
          KeyId: config.currentKeyArn,
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
          EncryptionContext: context(scope),
        });
        if (
          !(result.CiphertextBlob instanceof Uint8Array) ||
          result.KeyId !== config.currentKeyArn ||
          result.CiphertextBlob.length < 29 ||
          result.CiphertextBlob.length > 6144
        )
          throw unavailable();
        return {
          ciphertext: Buffer.from(result.CiphertextBlob),
          keyArn: result.KeyId,
          accountLast4: details.accountNumber.replace(/[ -]/g, "").slice(-4),
        };
      } catch {
        throw unavailable();
      }
    },
    async decrypt(scope: Scope, input: { ciphertext: Buffer; keyArn: string }) {
      try {
        if (
          !config.allowedKeyArns.includes(input.keyArn) ||
          !Buffer.isBuffer(input.ciphertext) ||
          input.ciphertext.length < 29 ||
          input.ciphertext.length > 6144
        )
          throw unavailable();
        const result = await config.kms.decrypt({
          CiphertextBlob: input.ciphertext,
          KeyId: input.keyArn,
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
          EncryptionContext: context(scope),
        });
        if (
          !(result.Plaintext instanceof Uint8Array) ||
          result.KeyId !== input.keyArn ||
          result.Plaintext.length > 4096
        )
          throw unavailable();
        return bankTransferDetailsSchema.parse(
          JSON.parse(Buffer.from(result.Plaintext).toString("utf8")),
        );
      } catch {
        throw unavailable();
      }
    },
  };
}
