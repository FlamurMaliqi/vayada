import { describe, expect, it, vi } from "vitest";

import {
  createKmsFinanceFolioRecipientDecoder,
  FinanceFolioRecipientCodecError,
  type FinanceFolioKmsDecryptPort,
  type FinanceFolioRecipientDecoderInput,
} from "./financeFolioRecipientCodec.js";

const KEY = "arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const OTHER_KEY = "arn:aws:kms:eu-west-1:123456789012:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PROPERTY = "11320000-0000-4000-8000-000000000001";
const FOLIO = "11320000-0000-4000-8000-000000000004";
const payload = Buffer.from(
  JSON.stringify({ v: 1, name: "Ada Lovelace", email: "ada@example.com" }),
);
const input: FinanceFolioRecipientDecoderInput = {
  propertyId: PROPERTY,
  folioId: FOLIO,
  revision: 2,
  ciphertext: Buffer.alloc(6_144, 1),
  encryptionScheme: "envelope_aead_v1",
  keyVersion: KEY,
};

describe("KMS Finance folio recipient decoder", () => {
  it("decrypts the opaque blob with exact scope context and a configured immutable key ARN", async () => {
    const decrypt = vi.fn(async () => ({ Plaintext: payload, KeyId: KEY }));
    const allowed = [KEY];
    const decoder = createKmsFinanceFolioRecipientDecoder({
      kms: { decrypt },
      allowedKeyArns: allowed,
    });
    allowed[0] = OTHER_KEY;

    await expect(decoder.decode(input)).resolves.toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(decrypt).toHaveBeenCalledWith({
      CiphertextBlob: input.ciphertext,
      KeyId: KEY,
      EncryptionContext: {
        purpose: "finance-folio-recipient-v1",
        propertyId: PROPERTY,
        folioId: FOLIO,
        revision: "2",
      },
    });
  });

  it("fails closed for missing, alias, and disallowed key configuration", async () => {
    const decrypt = vi.fn(async () => ({ Plaintext: payload, KeyId: KEY }));
    expect(() =>
      createKmsFinanceFolioRecipientDecoder({
        kms: undefined as never,
        allowedKeyArns: undefined as never,
      }),
    ).toThrow(FinanceFolioRecipientCodecError);
    expect(() =>
      createKmsFinanceFolioRecipientDecoder({ kms: { decrypt }, allowedKeyArns: [] }),
    ).toThrow(FinanceFolioRecipientCodecError);
    expect(() =>
      createKmsFinanceFolioRecipientDecoder({
        kms: { decrypt },
        allowedKeyArns: ["arn:aws:kms:eu-west-1:123456789012:alias/folio"],
      }),
    ).toThrow(FinanceFolioRecipientCodecError);

    const decoder = createKmsFinanceFolioRecipientDecoder({
      kms: { decrypt },
      allowedKeyArns: [OTHER_KEY],
    });
    await expect(decoder.decode(input)).rejects.toBeInstanceOf(FinanceFolioRecipientCodecError);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it.each([28, 6_145])("rejects ciphertext length %i", async (bytes) => {
    const decrypt = vi.fn(async () => ({ Plaintext: payload, KeyId: KEY }));
    const decoder = createKmsFinanceFolioRecipientDecoder({
      kms: { decrypt },
      allowedKeyArns: [KEY],
    });
    await expect(
      decoder.decode({ ...input, ciphertext: Buffer.alloc(bytes) }),
    ).rejects.toBeInstanceOf(FinanceFolioRecipientCodecError);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it.each([
    ["noncanonical key order", Buffer.from('{"name":"Ada","v":1,"email":null}'), KEY],
    ["an extra field", Buffer.from('{"v":1,"name":"Ada","email":null,"taxId":"x"}'), KEY],
    ["untrimmed recipient data", Buffer.from('{"v":1,"name":" Ada","email":null}'), KEY],
    ["an invalid email", Buffer.from('{"v":1,"name":"Ada","email":"ada"}'), KEY],
    ["a mismatched returned key", payload, OTHER_KEY],
    ["oversized plaintext", Buffer.alloc(4_097, 1), KEY],
  ])("rejects %s", async (_case, Plaintext, KeyId) => {
    const kms: FinanceFolioKmsDecryptPort = {
      async decrypt() {
        return { Plaintext, KeyId };
      },
    };
    const decoder = createKmsFinanceFolioRecipientDecoder({ kms, allowedKeyArns: [KEY] });
    await expect(decoder.decode(input)).rejects.toBeInstanceOf(FinanceFolioRecipientCodecError);
  });

  it("does not expose KMS failures", async () => {
    const kms: FinanceFolioKmsDecryptPort = {
      async decrypt() {
        throw new Error("sensitive upstream details");
      },
    };
    const decoder = createKmsFinanceFolioRecipientDecoder({ kms, allowedKeyArns: [KEY] });
    await expect(decoder.decode(input)).rejects.toMatchObject({
      code: "recipient_evidence_unavailable",
      message: "Finance folio recipient evidence is unavailable",
    });
  });
});
