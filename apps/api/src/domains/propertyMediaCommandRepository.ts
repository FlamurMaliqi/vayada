import { randomUUID } from "node:crypto";

import pg from "pg";

import type { PlatformMediaServingConfig } from "../platform/mediaServing.js";
import {
  createS3PropertyMediaVariantPublisher,
  type PropertyMediaVariantPublisher,
} from "../platform/propertyMediaVariantPublisher.js";
import { createPropertyMediaCommandExecutor } from "./propertyMediaCommand.js";
import { type CommandPool, type PropertyMediaReadModelSync } from "./propertyMediaCommandStore.js";
import { createPropertyMediaPublicationWorker } from "./propertyMediaPublicationWorker.js";

export type {
  AssignPropertyLogoCommand,
  PropertyMediaCommandResult,
  PropertyMediaPublicationBatchResult,
  ReplacePlatformAdminPropertyHeroCommand,
  ReplacePropertyPresentationMediaCommand,
} from "./propertyMediaCommandEnvelope.js";
export { propertyMediaCommandResultStatus } from "./propertyMediaCommandEnvelope.js";
export type { PropertyMediaVariantPublisher } from "../platform/propertyMediaVariantPublisher.js";

export function createPgS3PropertyMediaCommandRepository(config: {
  connectionString: string;
  serving: PlatformMediaServingConfig;
  syncReadModels: PropertyMediaReadModelSync;
  max?: number;
  pool?: CommandPool;
  publisher?: PropertyMediaVariantPublisher;
  now?: () => Date;
  randomId?: () => string;
}) {
  if (!config.connectionString.trim()) {
    throw new Error("Property media command repository connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool = (config.pool ??
    new pg.Pool({ connectionString: config.connectionString, max: config.max })) as CommandPool;
  const ownsPublisher = !config.publisher;
  const publisher = config.publisher ?? createS3PropertyMediaVariantPublisher(config.serving);
  const now = config.now ?? (() => new Date());
  const randomId = config.randomId ?? randomUUID;

  const worker = createPropertyMediaPublicationWorker({
    pool,
    publisher,
    serving: config.serving,
    now,
    randomId,
    syncReadModels: config.syncReadModels,
  });
  const commands = createPropertyMediaCommandExecutor({
    pool,
    serving: config.serving,
    now,
    randomId,
    syncReadModels: config.syncReadModels,
    processPublicationJob: worker.processPublicationJob,
  });

  return {
    ...commands,
    runPublicationBatch: worker.runPublicationBatch,
    async close() {
      if (ownsPublisher) await publisher.close?.();
      if (ownsPool) await pool.end();
    },
  };
}

export type PropertyMediaCommandRepository = ReturnType<
  typeof createPgS3PropertyMediaCommandRepository
>;
