import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { PmsInboxAttachmentMediaReadPort } from "../domains/pmsInboxAttachmentMedia.js";
import {
  createPrivateDownloadPolicy,
  type PlatformMediaServingConfig,
} from "../platform/mediaServing.js";
import type { PlatformMediaPrivateDownloadSigner } from "../platform/platformMediaS3.js";
import {
  sendPmsOperationsError,
  toPmsOperationsAccessError,
  type PmsOperationsError,
} from "./pmsOperations.js";
import { enforcePmsPropertyRoutePolicy } from "./pmsPropertyPolicy.js";

type Params = { propertyId: string; threadId: string; attachmentId: string };

export type PmsInboxAttachmentMediaRoutesOptions = {
  read: PmsInboxAttachmentMediaReadPort;
  signer: PlatformMediaPrivateDownloadSigner;
  serving: PlatformMediaServingConfig;
  propertyAccessRepository: PropertyAccessRepository;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH = "/pms/properties/:propertyId/messaging/threads/:threadId/attachments/:attachmentId";

export async function registerPmsInboxAttachmentMediaRoutes(
  app: FastifyInstance,
  options: PmsInboxAttachmentMediaRoutesOptions,
): Promise<void> {
  let closed = false;
  app.addHook("onClose", async () => {
    if (closed) return;
    closed = true;
    await options.read.close?.();
  });

  app.get<{ Params: Params }>(PATH, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization");
    const { propertyId, threadId, attachmentId } = request.params;
    if (!(await authorize(request, reply, propertyId, options.propertyAccessRepository)))
      return reply;
    if (![propertyId, threadId, attachmentId].every((value) => UUID.test(value)))
      return send(reply, {
        statusCode: 400,
        code: "invalid_query",
        category: "validation",
        message: "PMS Inbox attachment path is invalid.",
      });

    try {
      const media = await options.read.find(propertyId, threadId, attachmentId);
      if (!media)
        return send(reply, {
          statusCode: 404,
          code: "attachment_not_found",
          category: "not_found",
          message: "PMS Inbox attachment was not found.",
        });
      if (
        media.propertyId !== propertyId ||
        media.threadId !== threadId ||
        media.attachmentId !== attachmentId ||
        media.visibility !== "private" ||
        media.lifecycleStatus !== "active"
      )
        throw new Error("PMS Inbox attachment scope mismatch");
      const policy = createPrivateDownloadPolicy(options.serving, {
        bucketName: media.bucketName,
        storageKey: media.storageKey,
        visibility: media.visibility,
        status: media.lifecycleStatus,
        originalFilename: media.originalFilename,
        contentType: media.contentType,
      });
      const url = await options.signer.signPrivateDownload(policy);
      if (!secureUrl(url)) throw new Error("PMS Inbox attachment signer returned an unsafe URL");
      return reply.redirect(url);
    } catch (error) {
      request.log.error(
        { err: error, propertyId, threadId, attachmentId },
        "PMS Inbox attachment access failed",
      );
      return unavailable(reply);
    }
  });
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string,
  repository: PropertyAccessRepository,
): Promise<boolean> {
  try {
    await enforcePmsPropertyRoutePolicy(
      request,
      {
        propertyId,
        permission: "pms.inbox.read",
        allowedRelationships: ["owner", "operator", "front_desk"],
      },
      repository,
    );
    return true;
  } catch (error) {
    const contractError = toPmsOperationsAccessError(error, request, propertyId);
    if (contractError) send(reply, contractError);
    else {
      request.log.error({ err: error, propertyId }, "PMS Inbox attachment access check failed");
      unavailable(reply);
    }
    return false;
  }
}

function send(reply: FastifyReply, error: PmsOperationsError): FastifyReply {
  return sendPmsOperationsError(reply, error);
}

function unavailable(reply: FastifyReply): FastifyReply {
  return send(reply, {
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    message: "PMS Inbox attachment access is unavailable.",
  });
}

function secureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
