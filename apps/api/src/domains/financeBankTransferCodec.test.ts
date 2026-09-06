import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBankTransferCodec } from "./financeBankTransferCodec.js";

const keyArn = "arn:aws:kms:eu-central-1:123456789012:key/12345678-abcd";
const scope = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  id: "22222222-2222-4222-8222-222222222222",
  revision: 1,
};
const details = {
  accountHolder: "Private Holder",
  accountType: "iban",
  accountNumber: "DE89370400440532013000",
  bankName: "Private Bank",
  bicSwift: "COBADEFFXXX",
  instructions: "Private instructions",
};

function codec() {
  const key = randomBytes(32);
  return createBankTransferCodec({
    currentKeyArn: keyArn,
    allowedKeyArns: [keyArn],
    kms: {
      async encrypt(input) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(JSON.stringify(input.EncryptionContext)));
        const encrypted = Buffer.concat([cipher.update(input.Plaintext), cipher.final()]);
        return {
          KeyId: input.KeyId,
          CiphertextBlob: Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
        };
      },
      async decrypt(input) {
        const bytes = Buffer.from(input.CiphertextBlob);
        const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(12, 28));
        cipher.setAAD(Buffer.from(JSON.stringify(input.EncryptionContext)));
        return {
          KeyId: input.KeyId,
          Plaintext: Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]),
        };
      },
    },
  });
}

describe("bank transfer encryption boundary", () => {
  it("round-trips encrypted details and persists only a masked suffix beside ciphertext", async () => {
    const subject = codec();
    const encrypted = await subject.encrypt(scope, details);
    expect(encrypted.accountLast4).toBe("3000");
    for (const secret of [
      details.accountHolder,
      details.accountNumber,
      details.bankName,
      details.bicSwift,
      details.instructions,
    ])
      expect(JSON.stringify(encrypted)).not.toContain(secret);
    expect(await subject.decrypt(scope, encrypted)).toEqual(details);
    expect((await subject.encrypt(scope, details)).ciphertext).not.toEqual(encrypted.ciphertext);
  });

  it("rejects tenant, destination, revision and ciphertext substitution", async () => {
    const subject = codec();
    const encrypted = await subject.encrypt(scope, details);
    for (const changed of [
      { ...scope, propertyId: scope.id },
      { ...scope, id: scope.propertyId },
      { ...scope, revision: 2 },
    ]) {
      await expect(subject.decrypt(changed, encrypted)).rejects.toThrow(
        "Bank transfer destination unavailable.",
      );
    }
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[30] = tampered[30]! ^ 1;
    await expect(subject.decrypt(scope, { ...encrypted, ciphertext: tampered })).rejects.toThrow(
      "Bank transfer destination unavailable.",
    );
    await expect(subject.decrypt(scope, { ...encrypted, keyArn: "untrusted" })).rejects.toThrow(
      "Bank transfer destination unavailable.",
    );
  });

  it("does not expose invalid input or provider errors", async () => {
    const subject = codec();
    for (const invalid of [
      { ...details, accountNumber: "1234" },
      { ...details, accountHolder: "" },
      { ...details, unexpected: "secret" },
    ]) {
      await expect(subject.encrypt(scope, invalid)).rejects.toThrow(
        /^Bank transfer destination unavailable\.$/,
      );
    }
    const failing = createBankTransferCodec({
      currentKeyArn: keyArn,
      allowedKeyArns: [keyArn],
      kms: {
        async encrypt() {
          throw new Error(details.accountNumber);
        },
        async decrypt() {
          throw new Error(details.accountNumber);
        },
      },
    });
    await expect(failing.encrypt(scope, details)).rejects.toThrow(
      /^Bank transfer destination unavailable\.$/,
    );
    await expect(failing.decrypt(scope, { keyArn, ciphertext: Buffer.alloc(40) })).rejects.toThrow(
      /^Bank transfer destination unavailable\.$/,
    );
  });
});
