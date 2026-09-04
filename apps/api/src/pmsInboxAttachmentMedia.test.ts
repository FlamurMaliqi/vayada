import type { RequestContext } from "@vayada/backend-auth";
import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import Fastify from "fastify";
import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createPgPmsInboxAttachmentMediaReadPort,
  type PmsInboxAttachmentMedia,
  type PmsInboxAttachmentMediaPool,
} from "./domains/pmsInboxAttachmentMedia.js";
import type { PlatformMediaServingConfig } from "./platform/mediaServing.js";
import {
  registerPmsInboxAttachmentMediaRoutes,
  type PmsInboxAttachmentMediaRoutesOptions,
} from "./routes/pmsInboxAttachmentMedia.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const OTHER_PROPERTY = "22222222-2222-4222-8222-222222222222";
const THREAD = "33333333-3333-7333-8333-333333333333";
const ATTACHMENT = "44444444-4444-7444-8444-444444444444";
const MEDIA = "55555555-5555-7555-8555-555555555555";
const PATH = `/api/media/pms/properties/${PROPERTY}/messaging/threads/${THREAD}/attachments/${ATTACHMENT}`;

const serving: PlatformMediaServingConfig = {
  bucketName: "vayada-media",
  cdnBaseUrl: "https://cdn.example",
  cdnOriginHost: "origin.example",
  publicPathPrefix: "media",
  publicCacheControl: "public, max-age=31536000, immutable",
  privateDownloadTtlSeconds: 300,
  privateDownloadMaxTtlSeconds: 900,
};

const media: PmsInboxAttachmentMedia = {
  mediaId: MEDIA,
  propertyId: PROPERTY,
  threadId: THREAD,
  attachmentId: ATTACHMENT,
  bucketName: serving.bucketName,
  storageKey: `private/pms/${MEDIA}/guide.pdf`,
  visibility: "private",
  lifecycleStatus: "active",
  originalFilename: "arrival-guide.pdf",
  contentType: "application/pdf",
};

describe("PMS Inbox attachment media", () => {
  it("reads only canonical property, thread, attachment, and private media bindings", async () => {
    const calls: Array<[string, readonly unknown[] | undefined]> = [];
    const pool: PmsInboxAttachmentMediaPool = {
      async query<T extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
        calls.push([sql, values]);
        return {
          rows: [
            {
              ...media,
              originalFilename: media.originalFilename!,
              contentType: media.contentType!,
            },
          ] as unknown as T[],
        };
      },
    };
    const read = createPgPmsInboxAttachmentMediaReadPort({ connectionString: "", pool });

    await expect(read.find(PROPERTY, THREAD, ATTACHMENT)).resolves.toEqual(media);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual([PROPERTY, THREAD, ATTACHMENT]);
    expect(calls[0]![0]).toContain("attachment.property_id = $1::uuid");
    expect(calls[0]![0]).toContain("message.thread_id = $2::uuid");
    expect(calls[0]![0]).toContain("attachment.id = $3::uuid");
    expect(calls[0]![0]).toContain("media.resource_id = message.thread_id::text");
    expect(calls[0]![0]).toContain("media.resource_id = attachment.id::text");
    expect(calls[0]![0]).toContain("media.storage_key LIKE 'private/%'");
    expect(calls[0]![0]).not.toContain("source_url");
  });

  it("authorizes the property before redirecting to a short-lived signed download", async () => {
    const options = ports();
    const app = await build(options);
    const response = await app.inject({ method: "GET", url: PATH });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://signed.example/arrival-guide.pdf?expires=300");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toBe("Authorization");
    expect(options.read.find).toHaveBeenCalledWith(PROPERTY, THREAD, ATTACHMENT);
    expect(options.signer.signPrivateDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketName: serving.bucketName,
        storageKey: media.storageKey,
        method: "GET",
        expiresInSeconds: 300,
        responseContentDisposition: 'attachment; filename="arrival-guide.pdf"',
        responseContentType: "application/pdf",
      }),
    );
    await app.close();
    expect(options.read.close).toHaveBeenCalledOnce();
  });

  it("denies authentication, permission, entitlement, and property scope before media lookup", async () => {
    const cases: Array<[RequestContext | null, string, number, string]> = [
      [null, PATH, 401, "unauthenticated"],
      [context({ permissions: [] }), PATH, 403, "missing_permission"],
      [context({ entitlement: false }), PATH, 403, "missing_entitlement"],
      [context({ entitlementStatus: "suspended" }), PATH, 403, "inactive_entitlement"],
      [context({ pmsLink: false }), PATH, 403, "missing_resource_access"],
      [context(), PATH.replace(PROPERTY, OTHER_PROPERTY), 403, "missing_resource_access"],
    ];
    for (const [auth, path, statusCode, code] of cases) {
      const options = ports();
      const app = await build(options, auth);
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ statusCode, code, category: expect.any(String) });
      expect(options.read.find).not.toHaveBeenCalled();
      expect(options.signer.signPrivateDownload).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it("fails closed for malformed paths, missing media, scope mismatches, and unsafe signers", async () => {
    const cases: Array<[Partial<PmsInboxAttachmentMediaRoutesOptions>, string, number]> = [
      [{}, PATH.replace(ATTACHMENT, "opaque-attachment"), 400],
      [{ read: { find: vi.fn(async () => null) } }, PATH, 404],
      [{ read: { find: vi.fn(async () => ({ ...media, threadId: OTHER_PROPERTY })) } }, PATH, 500],
      [
        { signer: { signPrivateDownload: vi.fn(async () => "http://unsafe.example/file") } },
        PATH,
        500,
      ],
    ];
    for (const [override, path, statusCode] of cases) {
      const options = ports(override);
      const app = await build(options);
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(statusCode);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      await app.close();
    }
  });

  it("fails closed when property access resolution is unavailable", async () => {
    const options = ports({
      propertyAccessRepository: {
        findMembershipPropertyScope: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      },
    });
    const app = await build(options);
    const response = await app.inject({ method: "GET", url: PATH });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
    });
    expect(options.read.find).not.toHaveBeenCalled();
    await app.close();
  });
});

function ports(
  override: Partial<PmsInboxAttachmentMediaRoutesOptions> = {},
): PmsInboxAttachmentMediaRoutesOptions {
  return {
    read: { find: vi.fn(async () => media), close: vi.fn(async () => undefined) },
    signer: {
      signPrivateDownload: vi.fn(
        async () => "https://signed.example/arrival-guide.pdf?expires=300",
      ),
    },
    serving,
    propertyAccessRepository: propertyAccess(),
    ...override,
  };
}

async function build(
  options: PmsInboxAttachmentMediaRoutesOptions,
  auth: RequestContext | null = context(),
) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    request.authContext = auth;
  });
  app.register(registerPmsInboxAttachmentMediaRoutes, { prefix: "/api/media", ...options });
  return app;
}

function propertyAccess(): PropertyAccessRepository {
  return {
    async findMembershipPropertyScope() {
      return { mode: "all", roleKey: "owner", accessOrigin: "agency", assignedPropertyIds: [] };
    },
  };
}

function context(
  override: {
    permissions?: string[];
    entitlement?: boolean;
    entitlementStatus?: "active" | "suspended";
    pmsLink?: boolean;
  } = {},
): RequestContext {
  const relationship = "owner" as const;
  return {
    actor: { internalUserId: MEDIA, status: "active" },
    selectedOrganization: { organizationId: ATTACHMENT, kind: "hotel_group", status: "active" },
    membership: {
      membershipId: THREAD,
      roleKey: "owner",
      status: "active",
      permissions: override.permissions ?? ["pms.inbox.read"],
    },
    entitlements:
      override.entitlement === false
        ? []
        : [
            {
              product: "pms",
              key: "property-management",
              status: override.entitlementStatus ?? "active",
              resource: { product: "pms", resourceType: "pms_property", resourceId: PROPERTY },
            },
          ],
    linkedResources: [
      {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: PROPERTY,
        relationship,
        status: "active",
      },
      ...(override.pmsLink === false
        ? []
        : [
            {
              product: "pms" as const,
              resourceType: "pms_property" as const,
              resourceId: PROPERTY,
              relationship,
              status: "active" as const,
            },
          ]),
    ],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "request-1", receivedAt: "2026-09-02T08:00:00.000Z", source: "api" },
  } as unknown as RequestContext;
}
