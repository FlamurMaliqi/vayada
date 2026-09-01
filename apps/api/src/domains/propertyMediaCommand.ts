import type { PlatformMediaServingConfig } from "../platform/mediaServing.js";
import { advancePublicProfileRevision } from "../platform/sharedHotelSetupStatusReadModel.js";
import {
  commandAssignmentResponse,
  commandFingerprint,
  commandWithoutIdempotencyKey,
  isUuid,
  pendingPublicationJobId,
  positiveInteger,
  preparePublicationMedia,
  sha256,
  snapshotCommand,
  snapshotPlatformAdminHeroCommand,
  type AssignPropertyLogoCommand,
  type InternalCommand,
  type PropertyMediaCommandResult,
  type PublicationJobPayload,
  type ReplacePlatformAdminPropertyHeroCommand,
  type ReplacePropertyPresentationMediaCommand,
} from "./propertyMediaCommandEnvelope.js";
import {
  completeIdempotency,
  enqueuePublicationJob,
  findActivePublication,
  findIdempotency,
  loadAssignments,
  loadProfileRevision,
  lockPlatformAdminProperty,
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

  async function execute(
    input: InternalCommand | ReplacePlatformAdminPropertyHeroCommand,
  ): Promise<PropertyMediaCommandResult> {
    const platformAdminInput = isPlatformAdminHeroCommand(input)
      ? snapshotPlatformAdminHeroCommand(input)
      : null;
    let command = platformAdminInput ? null : snapshotCommand(input as InternalCommand);
    const occurredAt = now();
    const client = await pool.connect();
    let publicationJobId: string | null = null;
    let idempotentReplay = false;
    let keyHash = "";
    let fingerprint = "";
    try {
      await client.query("BEGIN");
      const property = platformAdminInput
        ? await lockPlatformAdminProperty(client, platformAdminInput.propertyId)
        : await lockProperty(client, command!);
      if (!property) {
        await client.query("ROLLBACK");
        return { ok: false, error: { code: "property_not_found" } };
      }
      if (platformAdminInput) {
        if (
          !("ownerOrganizationId" in property) ||
          typeof property.ownerOrganizationId !== "string"
        ) {
          throw new Error("Platform Admin property lock did not resolve its unique owner");
        }
        command = snapshotCommand({
          ...platformAdminInput,
          organizationId: property.ownerOrganizationId,
          operation: "presentation",
          assignments: platformAdminInput.mediaObjectId
            ? [
                {
                  mediaObjectId: platformAdminInput.mediaObjectId,
                  role: "cover" as const,
                  altText: null,
                  sortOrder: 0,
                },
              ]
            : [],
          platformAdminHero: true,
        });
      }
      const resolvedCommand = command!;
      keyHash = sha256(resolvedCommand.idempotencyKey);
      fingerprint = commandFingerprint(resolvedCommand);
      const idempotency = await findIdempotency(client, resolvedCommand, keyHash);
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
        const activePublication = await findActivePublication(client, resolvedCommand.propertyId);
        if (activePublication) {
          await client.query("ROLLBACK");
          return { ok: false, error: { code: "command_in_progress" } };
        }
        const idempotencyId = await reserveIdempotency(
          client,
          resolvedCommand,
          keyHash,
          fingerprint,
        );
        if (!idempotencyId) {
          await client.query("ROLLBACK");
          return { ok: false, error: { code: "command_in_progress" } };
        }

        const before = await loadAssignments(client, resolvedCommand.propertyId);
        const currentRevision = positiveInteger(property.profileRevision);
        if (currentRevision !== resolvedCommand.expectedProfileRevision) {
          const result: PropertyMediaCommandResult = {
            ok: false,
            error: { code: "profile_revision_conflict", currentRevision },
          };
          await recordFinalAudit(client, {
            command: resolvedCommand,
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

        const resolution = await resolveMedia(client, resolvedCommand, config.serving);
        if (!resolution.ok) {
          const result: PropertyMediaCommandResult = resolution;
          await recordFinalAudit(client, {
            command: resolvedCommand,
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
          await replaceAssignments(client, resolvedCommand, resolution.media);
          await advancePublicProfileRevision(client, resolvedCommand.propertyId);
          const completedProfileRevision = await loadProfileRevision(
            client,
            resolvedCommand.propertyId,
          );
          if (completedProfileRevision !== currentRevision + 1) {
            throw new Error("Property media command advanced an unexpected profile revision");
          }
          await syncReadModels(client, { propertyId: resolvedCommand.propertyId });
          const after = await loadAssignments(client, resolvedCommand.propertyId);
          const result: PropertyMediaCommandResult = {
            ok: true,
            response: commandAssignmentResponse(
              "updated",
              completedProfileRevision,
              after,
              resolvedCommand,
            ),
          };
          await recordFinalAudit(client, {
            command: resolvedCommand,
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
          command: commandWithoutIdempotencyKey(resolvedCommand),
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
        await stageAssignments(client, resolvedCommand, publicationJobId);
        await advancePublicProfileRevision(client, resolvedCommand.propertyId);
        const stagedProfileRevision = await loadProfileRevision(client, resolvedCommand.propertyId);
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
    return readCompletedResult(pool, command!, keyHash, fingerprint, idempotentReplay);
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
    replacePlatformAdminHero(command: ReplacePlatformAdminPropertyHeroCommand) {
      return execute(command);
    },
  };
}

function isPlatformAdminHeroCommand(
  input: InternalCommand | ReplacePlatformAdminPropertyHeroCommand,
): input is ReplacePlatformAdminPropertyHeroCommand {
  return !("organizationId" in input);
}
