import { DecryptCommand, EncryptCommand, GenerateMacCommand } from "@aws-sdk/client-kms";
import { describe, expect, it, vi } from "vitest";

import { createAwsFinanceFolioKms } from "./financeFolioKms.js";

describe("AWS Finance folio KMS adapter", () => {
  it("maps only the three reviewed KMS operations", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof EncryptCommand)
        return { CiphertextBlob: Buffer.alloc(32), KeyId: "e" };
      if (command instanceof GenerateMacCommand)
        return { Mac: Buffer.alloc(32), KeyId: "m", MacAlgorithm: "HMAC_SHA_256" };
      return { Plaintext: Buffer.from("{}"), KeyId: "e" };
    });
    const kms = createAwsFinanceFolioKms({ client: { send } as never });
    await kms.write.encrypt({
      Plaintext: Buffer.from("{}"),
      KeyId: "e",
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      EncryptionContext: { purpose: "test" },
    });
    await kms.write.generateMac({
      Message: Buffer.alloc(32),
      KeyId: "m",
      MacAlgorithm: "HMAC_SHA_256",
    });
    await kms.decrypt.decrypt({
      CiphertextBlob: Buffer.alloc(32),
      KeyId: "e",
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      EncryptionContext: { purpose: "test" },
    });

    const sent = send.mock.calls.map(
      ([command]) => command as { constructor: unknown; input: unknown },
    );
    expect(sent.map((command) => command.constructor)).toEqual([
      EncryptCommand,
      GenerateMacCommand,
      DecryptCommand,
    ]);
    expect(sent.map((command) => command.input)).toEqual([
      {
        Plaintext: Buffer.from("{}"),
        KeyId: "e",
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: { purpose: "test" },
      },
      { Message: Buffer.alloc(32), KeyId: "m", MacAlgorithm: "HMAC_SHA_256" },
      {
        CiphertextBlob: Buffer.alloc(32),
        KeyId: "e",
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: { purpose: "test" },
      },
    ]);
  });
});
