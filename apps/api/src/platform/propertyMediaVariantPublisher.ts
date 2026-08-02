import { CopyObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

import type { PlatformMediaServingConfig } from "./mediaServing.js";

const S3_CONNECTION_TIMEOUT_MS = 5_000;
const S3_REQUEST_TIMEOUT_MS = 30_000;

export type PropertyMediaVariantPublisher = {
  copyToPublic(input: {
    privateStorageKey: string;
    publicStorageKey: string;
    contentType: string;
  }): Promise<void>;
  deletePublic(input: { publicStorageKey: string }): Promise<void>;
  close?(): Promise<void> | void;
};

export function createS3PropertyMediaVariantPublisher(
  serving: PlatformMediaServingConfig,
): PropertyMediaVariantPublisher {
  const s3 = new S3Client({
    requestChecksumCalculation: "WHEN_REQUIRED",
    requestHandler: NodeHttpHandler.create({
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
      socketTimeout: S3_REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    }),
  });
  return {
    async copyToPublic(input) {
      await s3.send(
        new CopyObjectCommand({
          Bucket: serving.bucketName,
          CopySource: `${serving.bucketName}/${input.privateStorageKey
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
          Key: input.publicStorageKey,
          ContentType: input.contentType,
          CacheControl: serving.publicCacheControl,
          MetadataDirective: "REPLACE",
        }),
      );
    },
    async deletePublic(input) {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: serving.bucketName,
          Key: input.publicStorageKey,
        }),
      );
    },
    close() {
      s3.destroy();
    },
  };
}
