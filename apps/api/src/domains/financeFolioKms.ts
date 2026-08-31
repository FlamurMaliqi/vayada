import {
  DecryptCommand,
  EncryptCommand,
  GenerateMacCommand,
  KMSClient,
  type KMSClientConfig,
} from "@aws-sdk/client-kms";

import type {
  FinanceFolioKmsDecryptPort,
  FinanceFolioKmsWritePort,
} from "./financeFolioRecipientCodec.js";

type KmsSender = Pick<KMSClient, "send">;

export function createAwsFinanceFolioKms(config: KMSClientConfig & { client?: KmsSender }) {
  const owned = !config.client;
  const client = config.client ?? new KMSClient(config);
  const write: FinanceFolioKmsWritePort = {
    encrypt: (input) => client.send(new EncryptCommand({ ...input })),
    generateMac: (input) => client.send(new GenerateMacCommand({ ...input })),
  };
  const decrypt: FinanceFolioKmsDecryptPort = {
    decrypt: (input) => client.send(new DecryptCommand({ ...input })),
  };
  return {
    write,
    decrypt,
    close() {
      if (owned) (client as KMSClient).destroy();
    },
  };
}
