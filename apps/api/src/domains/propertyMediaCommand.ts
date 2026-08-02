import type { PlatformMediaServingConfig } from "../platform/mediaServing.js";
import { advancePublicProfileRevision } from "../platform/sharedHotelSetupStatusReadModel.js";
import {
  assignmentResponse,
  commandFingerprint,
  commandWithoutIdempotencyKey,
  isUuid,
  pendingPublicationJobId,
  positiveInteger,
  preparePublicationMedia,
  sha256,
  snapshotCommand,
  type AssignPropertyLogoCommand,
  type InternalCommand,
  type PropertyMediaCommandResult,
  type PublicationJobPayload,
  type ReplacePropertyPresentationMediaCommand,
} from "./propertyMediaCommandEnvelope.js";
import {
  completeIdempotency,
  enqueuePublicationJob,
  findActivePublication,
  findIdempotency,
  loadAssignments,
  loadProfileRevision,
  lockProperty,
  markIdempotencyPending,
  readCompletedResult,
  recordAcceptedAudit,
  recordFinalAudit,
  replaceAssignments,
  replayIdempotency,
  reserveIdempotency,
  resolveMedia,
  stageAssignments,
  type CommandPool,
  type PropertyMediaReadModelSync,
} from "./propertyMediaCommandStore.js";

export type PropertyMediaPublicationProcessor = (
  jobId?: string,
  force?: boolean,
) => Promise<"processed" | "deferred" | "dead_lettered" | "not_claimed">;

export function createPropertyMediaCommandExecutor(config: {
  pool: CommandPool;
  serving: PlatformMediaServingConfig;
  now: () => Date;
  randomId: () => string;
  syncReadModels: PropertyMediaReadModelSync;
  processPublicationJob: PropertyMediaPublicationProcessor;
}) {
  const { pool, now, randomId, syncReadModels, processPublicationJob } = config;

  async function execute(input: InternalCommand): Promise<PropertyMediaCommandResult> {
    const command = snapshotCommand(input);
    const occurredAt = now();
    const keyHash = sha256(command.idempotencyKey);
    const fingerprint = commandFingerprint(command);
    const client = await pool.connect();
    let publicationJobId: string | null = null;
    let idempotentReplay = false;
    try {
      await client.query("BEGIN");
      const property = await lockProperty(client, command);
      if (!property) {
        await client.query("ROLLBACK");
        return { ok: false, error: { code: "property_not_found" } };
      }
      const idempotency = await findIdempotency(client, command, keyHash);
      if (idempotency) {
        idempotentReplay = true;
        const replay = replayIdempotency(idempotency, fingerprint);
        if (replay) {
          await client.query("ROLLBACK");
          return replay.ok
            ? { ok: true, response: { ...replay.response, outcome: "idempotent_replay" } }
            : replay;
        }
        if (idempotency.requestFingerprintHash !== fingerprint) {
          await client.query("ROLLBACK");
          return { ok: false, error: { code: "idempotency_key_conflict" } };
        }
        publicationJobId = pendingPublicationJobId(idempotency.metadata);
        await client.query("ROLLBACK");
        if (!publicationJobId) return { ok: false, error: { code: "command_in_progress" } };
      } else {
        const activePublication = await findActivePublication(client, command.propertyId);
        if (activePublication) {
          await client.query("ROLLBACK");
          return { ok: false, error: { code: "command_in_progress" } };
        }
        const idempotencyId = await reserveIdempotency(client, command, keyHash, fingerprint);
        if (!idempotencyId) {
          await client.query("ROLLBACK");
          return { ok: false, error: { code: "command_in_progress" } };
        }

        const before = await loadAssignments(client, command.propertyId);
        const currentRevision = positiveInteger(property.profileRevision);
        if (currentRevision !== command.expectedProfileRevision) {
          const result: PropertyMediaCommandResult = {
            ok: false,
            error: { code: "profile_revision_conflict", currentRevision },
          };
          await recordFinalAudit(client, {
            command,
            idempotencyId,
            keyHash,
            before,
            result,
            occurredAt,
          });
          await completeIdempotency(client, idempotencyId, result, occurredAt);
          await client.query("COMMIT");
          return result;
        }

        const resolution = await resolveMedia(client, command, config.serving);
        if (!resolution.ok) {
          const result: PropertyMediaCommandResult = resolution;
          await recordFinalAudit(client, {
            command,
            idempotencyId,
            keyHash,
            before,
            result,
            occurredAt,
          });
          await completeIdempotency(client, idempotencyId, result, occurredAt);
          await client.query("COMMIT");
          return result;
        }

        if (resolution.media.every(({ promotion }) => promotion.length === 0)) {
          await replaceAssignments(client, command, resolution.media);
          await advancePublicProfileRevision(client, command.propertyId);
          const completedProfileRevision = await loadProfileRevision(client, command.propertyId);
          if (completedProfileRevision !== currentRevision + 1) {
            throw new Error("Property media command advanced an unexpected profile revision");
          }
          await syncReadModels(client, { propertyId: command.propertyId });
          const after = await loadAssignments(client, command.propertyId);
          const result: PropertyMediaCommandResult = {
            ok: true,
            response: assignmentResponse("updated", completedProfileRevision, after),
          };
          await recordFinalAudit(client, {
            command,
            idempotencyId,
            keyHash,
            before,
            result,
            occurredAt,
          });
          await completeIdempotency(client, idempotencyId, result, occurredAt);
          await client.query("COMMIT");
          return result;
        }

        const publicationToken = randomId().toLowerCase();
        if (!isUuid(publicationToken)) {
          throw new Error("Property media publication token must be a UUID");
        }
        const acceptedProfileRevision = currentRevision + 1;
        const payload: PublicationJobPayload = {
          version: 2,
          command: commandWithoutIdempotencyKey(command),
          idempotencyId,
          keyHash,
          requestFingerprintHash: fingerprint,
          publicationToken,
          acceptedProfileRevision,
          acceptedAt: occurredAt.toISOString(),
          before,
          media: preparePublicationMedia(resolution.media, publicationToken, config.serving),
        };
        publicationJobId = await enqueuePublicationJob(client, payload);
        await stageAssignments(client, command, publicationJobId);
        await advancePublicProfileRevision(client, command.propertyId);
        const stagedProfileRevision = await loadProfileRevision(client, command.propertyId);
        if (stagedProfileRevision !== acceptedProfileRevision) {
          throw new Error("Property media assignment staging advanced an unexpected revision");
        }
        await markIdempotencyPending(client, {
          idempotencyId,
          publicationJobId,
          acceptedProfileRevision,
          occurredAt,
        });
        await recordAcceptedAudit(client, payload, publicationJobId);
        await client.query("COMMIT");
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    if (!publicationJobId) return { ok: false, error: { code: "command_in_progress" } };
    await processPublicationJob(publicationJobId, !idempotentReplay);
    return readCompletedResult(pool, command, keyHash, fingerprint, idempotentReplay);
  }

  return {
    assignLogo(command: AssignPropertyLogoCommand) {
      return execute({
        ...command,
        operation: "logo",
        assignments: command.assignment ? [command.assignment] : [],
      });
    },
    replacePresentation(command: ReplacePropertyPresentationMediaCommand) {
      return execute({ ...command, operation: "presentation" });
    },
  };
}
