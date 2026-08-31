import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createKmsFinanceFolioRecipientEncoder,
  createKmsFinanceFolioRecipientDecoder,
  FinanceFolioRecipientCodecError,
  type FinanceFolioKmsDecryptPort,
  type FinanceFolioKmsWritePort,
  type FinanceFolioRecipientDecoderInput,
} from "./financeFolioRecipientCodec.js";

const KEY = "arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const OTHER_KEY = "arn:aws:kms:eu-west-1:123456789012:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MAC_KEY = "arn:aws:kms:eu-west-1:123456789012:key/99999999-8888-7777-6666-555555555555";
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

describe("KMS Finance folio recipient encoder", () => {
  it("encrypts exact revision evidence and creates a property-scoped keyed fingerprint", async () => {
    const encrypt = vi.fn(async () => ({ CiphertextBlob: Buffer.alloc(64, 1), KeyId: KEY }));
    const generateMac = vi.fn(async () => ({
      Mac: Buffer.alloc(32, 2),
      KeyId: MAC_KEY,
      MacAlgorithm: "HMAC_SHA_256",
    }));
    const encoder = createKmsFinanceFolioRecipientEncoder({
      kms: { encrypt, generateMac },
      currentKeyArn: KEY,
      currentFingerprintKeyArn: MAC_KEY,
    });

    await expect(
      encoder.encode({
        propertyId: PROPERTY,
        folioId: FOLIO,
        revision: 2,
        recipient: { name: "Ada Lovelace", email: "ada@example.com" },
      }),
    ).resolves.toEqual({
      ciphertext: Buffer.alloc(64, 1),
      encryptionScheme: "envelope_aead_v1",
      keyVersion: KEY,
      fingerprint: "02".repeat(32),
      fingerprintKeyVersion: MAC_KEY,
    });
    expect(encrypt).toHaveBeenCalledWith({
      Plaintext: payload,
      KeyId: KEY,
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      EncryptionContext: {
        purpose: "finance-folio-recipient-v1",
        propertyId: PROPERTY,
        folioId: FOLIO,
        revision: "2",
      },
    });
    expect(generateMac).toHaveBeenCalledWith({
      Message: fingerprintDigest({ name: "Ada Lovelace", email: "ada@example.com" }),
      KeyId: MAC_KEY,
      MacAlgorithm: "HMAC_SHA_256",
    });
  });

  it("fingerprints only the canonical recipient and keeps the KMS message fixed-size", async () => {
    const kms = writePort();
    const encoder = createKmsFinanceFolioRecipientEncoder({
      kms,
      currentKeyArn: KEY,
      currentFingerprintKeyArn: MAC_KEY,
    });
    await encoder.encode({
      propertyId: PROPERTY,
      folioId: FOLIO,
      revision: 2,
      recipient: {
        email: "ada@example.com",
        name: "Ada Lovelace",
        taxId: "must-not-reach-kms",
      } as never,
    });
    const call = kms.generateMac.mock.calls[0]![0];
    expect(call.Message).toEqual(
      fingerprintDigest({
        name: "Ada Lovelace",
        email: "ada@example.com",
      }),
    );
    expect(call.Message).toHaveLength(32);
    await encoder.encode({
      propertyId: PROPERTY,
      folioId: FOLIO,
      revision: 3,
      recipient: { name: "a".repeat(4_000), email: null },
    });
    expect(kms.generateMac.mock.calls[1]![0].Message).toHaveLength(32);
  });

  it.each([
    ["invalid scope", { propertyId: "not-a-property" }],
    ["untrimmed recipient", { recipient: { name: " Ada", email: null } }],
    ["oversized recipient", { recipient: { name: "é".repeat(3_000), email: null } }],
  ])("rejects %s before KMS", async (_label, change) => {
    const kms = writePort();
    const encoder = createKmsFinanceFolioRecipientEncoder({
      kms,
      currentKeyArn: KEY,
      currentFingerprintKeyArn: MAC_KEY,
    });
    await expect(
      encoder.encode({
        propertyId: PROPERTY,
        folioId: FOLIO,
        revision: 2,
        recipient: { name: "Ada", email: null },
        ...change,
      }),
    ).rejects.toBeInstanceOf(FinanceFolioRecipientCodecError);
    expect(kms.encrypt).not.toHaveBeenCalled();
    expect(kms.generateMac).not.toHaveBeenCalled();
  });

  it("fails closed on invalid key configuration or malformed KMS evidence", async () => {
    expect(() =>
      createKmsFinanceFolioRecipientEncoder({
        kms: writePort(),
        currentKeyArn: KEY,
        currentFingerprintKeyArn: KEY,
      }),
    ).toThrow(FinanceFolioRecipientCodecError);
    const kms = writePort({
      mac: { Mac: Buffer.alloc(31), KeyId: MAC_KEY, MacAlgorithm: "HMAC_SHA_256" },
    });
    const encoder = createKmsFinanceFolioRecipientEncoder({
      kms,
      currentKeyArn: KEY,
      currentFingerprintKeyArn: MAC_KEY,
    });
    await expect(
      encoder.encode({
        propertyId: PROPERTY,
        folioId: FOLIO,
        revision: 2,
        recipient: { name: "Ada", email: null },
      }),
    ).rejects.toMatchObject({ code: "recipient_evidence_unavailable" });
  });

  it.each([
    ["ciphertext", { encrypted: { CiphertextBlob: "x".repeat(64) as never, KeyId: KEY } }],
    [
      "MAC",
      { mac: { Mac: "x".repeat(32) as never, KeyId: MAC_KEY, MacAlgorithm: "HMAC_SHA_256" } },
    ],
  ])("rejects non-binary %s evidence", async (_label, result) => {
    const encoder = createKmsFinanceFolioRecipientEncoder({
      kms: writePort(result),
      currentKeyArn: KEY,
      currentFingerprintKeyArn: MAC_KEY,
    });
    await expect(
      encoder.encode({
        propertyId: PROPERTY,
        folioId: FOLIO,
        revision: 2,
        recipient: { name: "Ada", email: null },
      }),
    ).rejects.toBeInstanceOf(FinanceFolioRecipientCodecError);
  });
});

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
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
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

function writePort(
  result: {
    encrypted?: { CiphertextBlob: Uint8Array; KeyId: string };
    mac?: { Mac: Uint8Array; KeyId: string; MacAlgorithm: string };
  } = {},
) {
  return {
    encrypt: vi.fn(
      async (_input: Parameters<FinanceFolioKmsWritePort["encrypt"]>[0]) =>
        result.encrypted ?? { CiphertextBlob: Buffer.alloc(64), KeyId: KEY },
    ),
    generateMac: vi.fn(
      async (_input: Parameters<FinanceFolioKmsWritePort["generateMac"]>[0]) =>
        result.mac ?? { Mac: Buffer.alloc(32), KeyId: MAC_KEY, MacAlgorithm: "HMAC_SHA_256" },
    ),
  } satisfies FinanceFolioKmsWritePort;
}

function fingerprintDigest(recipient: { name: string; email: string | null }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        purpose: "finance-folio-recipient-fingerprint-v1",
        propertyId: PROPERTY,
        recipient,
      }),
    )
    .digest();
}
