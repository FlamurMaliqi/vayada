import {
  requireAuthContext,
  type LinkedResource,
  type PermissionKey,
  type Product,
  type RequestContext,
  type ResourceRelationship,
  type ResourceType,
} from "@vayada/backend-auth";
import {
  MARKETPLACE_COLLABORATION_CREATOR_WRITE_POLICY,
  MARKETPLACE_COLLABORATION_HOTEL_WRITE_POLICY,
} from "@vayada/domain-marketplace";
import {
  PROPERTY_MEDIA_AUTHORIZATION,
  PROPERTY_MEDIA_PUBLIC_VARIANTS,
  PROPERTY_MEDIA_UPLOAD_PURPOSES,
  type PropertyMediaLibraryItem,
} from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  isCanonicalPrivatePropertyMediaObject,
  normalizePlatformMediaPathPrefix,
  PROPERTY_MEDIA_PUBLIC_VARIANT_MAX_DIMENSIONS,
} from "../platform/propertyMediaVariantContract.js";
import { enforceRoutePolicy } from "./policy.js";

export const PLATFORM_MEDIA_UPLOAD_CONTRACT_VERSION = "platform-media-upload.v1" as const;
export const CANONICAL_HOTEL_MEDIA_UPLOAD_CONTRACT_VERSION = "platform-media-upload.v2" as const;
export const PLATFORM_MEDIA_IMPORT_CONTRACT_VERSION = "platform-media-import.v1" as const;

export type PlatformMediaPurpose =
  | "identity.user.profile_image"
  | "booking.header_logo"
  | "booking.addon.image"
  | "property.hero_image"
  | "property.gallery_image"
  | "property.logo"
  | "marketplace.offer.media"
  | "marketplace.creator.profile_image"
  | "marketplace.collaboration_chat.attachment"
  | "pms.room_type.media"
  | "pms.messaging.attachment"
  | "pms.import.source_image"
  | "finance.expense.receipt";

export type PlatformMediaVisibility = "public" | "private";

export type PlatformMediaVariantName =
  | "original_safe"
  | "large"
  | "thumbnail"
  | "blur_preview"
  | "provider_original";

export type PlatformMediaResourceProduct =
  | "hotel_catalog"
  | "booking"
  | "pms"
  | "finance"
  | "marketplace"
  | "distribution"
  | "platform"
  | "migration";

export type PlatformMediaResourceScope = {
  product: Product;
  resourceType: ResourceType;
  resourceId: string;
  propertyId?: string;
  targetResourceId?: string;
};

export type PlatformMediaUploadFileRequest = {
  clientFileId?: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export type PlatformMediaUploadSessionRequest = {
  idempotencyKey?: string;
  purpose: PlatformMediaPurpose;
  visibility?: PlatformMediaVisibility;
  resource: PlatformMediaResourceScope;
  files: PlatformMediaUploadFileRequest[];
};

export type PlatformMediaFinalizeFileRequest = {
  uploadTargetId: string;
  contentType?: string;
  sizeBytes?: number;
  checksumSha256?: string;
  widthPx?: number;
  heightPx?: number;
};

export type PlatformMediaFinalizeRequest = {
  files: PlatformMediaFinalizeFileRequest[];
};

export type PlatformMediaUploadTarget = {
  uploadTargetId: string;
  clientFileId: string;
  method: "PUT";
  uploadUrl: string;
  headers: Record<string, string>;
  stagingKey: string;
  expiresAt: string;
};

export type PlatformMediaResolvedTarget = {
  resourceProduct: PlatformMediaResourceProduct;
  resourceType: string;
  resourceId: string;
  propertyId?: string;
};

export type PlatformMediaSessionRecord = {
  sessionId: string;
  uploadSessionKey: string;
  purpose: PlatformMediaPurpose;
  requestedVisibility: PlatformMediaVisibility;
  effectiveVisibility: PlatformMediaVisibility;
  actorUserId: string;
  ownerOrganizationId: string;
  platformAdmin?: true;
  resource: PlatformMediaResourceScope;
  target: PlatformMediaResolvedTarget;
  files: Array<
    PlatformMediaUploadFileRequest & {
      clientFileId: string;
      uploadTargetId: string;
      mediaId: string;
    }
  >;
  uploadTargets: PlatformMediaUploadTarget[];
  stagingPrefix: string;
  status: "signed" | "completed" | "failed";
  expiresAt: string;
  createdAt: string;
  completedAt?: string;
  completedMediaObject?: PlatformMediaObjectRecord;
  completedMediaObjects?: PlatformMediaObjectRecord[];
};

export type PlatformMediaVariantRecord = {
  variantName: PlatformMediaVariantName;
  visibility: PlatformMediaVisibility;
  storageKey: string;
  contentType: string;
  widthPx?: number;
  heightPx?: number;
  sizeBytes: number;
  checksumSha256?: string;
  publicCdnUrl: string | null;
};

export type PlatformMediaObjectRecord = {
  mediaId: string;
  purpose: PlatformMediaPurpose;
  visibility: PlatformMediaVisibility;
  requestedVisibility: PlatformMediaVisibility;
  approvalStatus: "pending_domain_approval" | "private" | "approved";
  lifecycleStatus: "staged" | "active";
  storageKind: "vayada_managed" | "external_reference";
  bucket: string;
  storageKey: string;
  ownerOrganizationId: string;
  actorUserId: string;
  resourceProduct: PlatformMediaResourceProduct;
  resourceType: string;
  resourceId: string;
  propertyId?: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256?: string;
  widthPx?: number;
  heightPx?: number;
  originalFilename: string;
  sourceMetadata?: Record<string, unknown>;
  retainedUntil?: string | null;
  variants: PlatformMediaVariantRecord[];
  createdAt: string;
};

export type PlatformMediaAuditEvent = {
  action:
    | "platform_media.upload_session.created"
    | "platform_media.upload_session.finalized"
    | "platform_media.import_job.created";
  auditKey: string;
  actorUserId: string;
  organizationId: string;
  targetType: "media_upload_session" | "media_object" | "media_import_job";
  targetId: string;
  requestId: string;
  metadata: Record<string, unknown>;
};

export type PlatformMediaImportRequest = {
  purpose: "pms.import.source_image";
  resource: PlatformMediaResourceScope;
  sourceImageUrls: string[];
  idempotencyKey?: string;
};

export type PlatformMediaImportJobRecord = {
  importJobId: string;
  jobKey: string;
  purpose: "pms.import.source_image";
  status: "pending";
  actorUserId: string;
  ownerOrganizationId: string;
  sourceImageUrls: string[];
  resource: PlatformMediaResourceScope;
  target: PlatformMediaResolvedTarget;
  createdAt: string;
};

export type PlatformMediaFinalizedFileInspection = {
  contentType: string;
  sizeBytes: number;
  checksumSha256?: string;
  widthPx?: number;
  heightPx?: number;
};

export type PlatformMediaFinalizedFileRecord = {
  sessionFile: PlatformMediaSessionRecord["files"][number];
  uploadTarget: PlatformMediaUploadTarget;
  inspection: PlatformMediaFinalizedFileInspection;
};

export type PlatformMediaCompleteUploadSessionResult = {
  uploadSession: PlatformMediaSessionRecord;
  mediaObjects: PlatformMediaObjectRecord[];
};

export class PlatformMediaCompletionError extends Error {
  readonly code = "platform_media_completion_failed";

  constructor(
    readonly outcome: "rolled_back" | "unknown",
    cause: unknown,
  ) {
    super(
      outcome === "rolled_back"
        ? "Platform media completion was rolled back."
        : "Platform media completion outcome is unknown.",
      { cause },
    );
    this.name = "PlatformMediaCompletionError";
  }
}

export class PlatformMediaTargetInvalidError extends Error {
  readonly code = "platform_media_target_invalid";

  constructor() {
    super("The platform media target no longer matches the signed session.");
    this.name = "PlatformMediaTargetInvalidError";
  }
}

export class PlatformMediaPlanLimitError extends Error {
  readonly code = "media_plan_limit_reached";

  constructor(
    readonly plan: "commission" | "fixed",
    readonly currentCount: number,
    readonly maxAllowed: number,
  ) {
    super(
      plan === "commission"
        ? currentCount > maxAllowed
          ? "You have more photos than your plan allows. Remove photos to add new ones, or upgrade for up to 15."
          : "You've reached the 10-photo limit. Upgrade to the paid plan for up to 15 photos per room."
        : "You've reached the 15-photo limit for the paid plan.",
    );
    this.name = "PlatformMediaPlanLimitError";
  }
}

export class PlatformMediaStagingChangedError extends Error {
  readonly code = "platform_media_staging_changed";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PlatformMediaStagingChangedError";
  }
}

export type PlatformMediaRepository = {
  createUploadSession(input: {
    sessionId: string;
    uploadSessionKey: string;
    stagingPrefix: string;
    context: RequestContext;
    request: PlatformMediaUploadSessionRequest;
    policy: PlatformMediaPurposePolicy;
    target: PlatformMediaResolvedTarget;
    ownerOrganizationId: string;
    platformAdmin?: boolean;
    uploadTargets: PlatformMediaUploadTarget[];
    now: string;
    expiresAt: string;
    auditEvent: PlatformMediaAuditEvent;
  }): Promise<PlatformMediaSessionRecord>;
  renewSignedUploadSession(input: {
    session: PlatformMediaSessionRecord;
    expiresAt: string;
    now: string;
  }): Promise<PlatformMediaSessionRecord>;
  findUploadSession(sessionId: string): Promise<PlatformMediaSessionRecord | null>;
  findUploadSessionForActor(input: {
    sessionId: string;
    actorUserId: string;
    ownerOrganizationId: string;
  }): Promise<PlatformMediaSessionRecord | null>;
  findMediaObject(mediaId: string): Promise<PlatformMediaObjectRecord | null>;
  completeUploadSession(input: {
    session: PlatformMediaSessionRecord;
    files: PlatformMediaFinalizedFileRecord[];
    variantSets: PlatformMediaVariantRecord[][];
    bucketName: string;
    now: string;
    auditEvent: PlatformMediaAuditEvent;
  }): Promise<PlatformMediaCompleteUploadSessionResult>;
  createImportJob(input: {
    importJobId: string;
    jobKey: string;
    context: RequestContext;
    request: PlatformMediaImportRequest;
    policy: PlatformMediaPurposePolicy;
    target: PlatformMediaResolvedTarget;
    now: string;
  }): Promise<PlatformMediaImportJobRecord>;
  recordAudit(event: PlatformMediaAuditEvent): Promise<void>;
  close?(): Promise<void>;
};

export type ApprovedPublicProfileImageRepository = {
  persistent?: boolean;
  publicCdnBaseUrl?: string;
  findMediaObject(mediaId: string): Promise<PlatformMediaObjectRecord | null>;
};

export type ApprovedPublicProfileImageTarget = {
  purpose: "identity.user.profile_image" | "marketplace.creator.profile_image";
  resourceProduct: PlatformMediaResourceProduct;
  resourceType: string;
  resourceId: string;
};

export async function resolveApprovedPublicProfileImage(input: {
  repository?: ApprovedPublicProfileImageRepository;
  mediaId: string;
  actorUserId: string;
  ownerOrganizationId: string;
  allowedTargets: ApprovedPublicProfileImageTarget[];
}): Promise<{ ok: true; publicCdnUrl: string } | { ok: false; reason: "unavailable" | "invalid" }> {
  const { repository } = input;
  if (!repository?.persistent || !repository.publicCdnBaseUrl) {
    return { ok: false, reason: "unavailable" };
  }

  const mediaObject = await repository.findMediaObject(input.mediaId);
  const matchedTarget = input.allowedTargets.find(
    (target) =>
      mediaObject?.purpose === target.purpose &&
      mediaObject.resourceProduct === target.resourceProduct &&
      mediaObject.resourceType === target.resourceType &&
      mediaObject.resourceId === target.resourceId,
  );
  const organizationAllowed =
    matchedTarget?.purpose === "identity.user.profile_image" ||
    mediaObject?.ownerOrganizationId === input.ownerOrganizationId;
  const canonicalVariant = mediaObject?.variants.find(
    (variant) => variant.variantName === "original_safe",
  );
  const publicCdnUrl = canonicalVariant?.publicCdnUrl ?? null;
  const isApprovedPublicImage =
    mediaObject?.actorUserId === input.actorUserId &&
    organizationAllowed &&
    matchedTarget !== undefined &&
    mediaObject.storageKind === "vayada_managed" &&
    mediaObject.requestedVisibility === "public" &&
    mediaObject.visibility === "public" &&
    mediaObject.approvalStatus === "approved" &&
    mediaObject.lifecycleStatus === "active" &&
    mediaObject.contentType.startsWith("image/") &&
    !mediaObject.storageKey.startsWith("staging/") &&
    canonicalVariant?.visibility === "public" &&
    canonicalVariant.contentType.startsWith("image/") &&
    !canonicalVariant.storageKey.startsWith("staging/") &&
    publicCdnUrl !== null &&
    isUrlUnderBase(publicCdnUrl, repository.publicCdnBaseUrl);

  return isApprovedPublicImage && publicCdnUrl
    ? { ok: true, publicCdnUrl }
    : { ok: false, reason: "invalid" };
}

function isUrlUnderBase(value: string, base: string): boolean {
  try {
    const url = new URL(value);
    const baseUrl = new URL(base);
    const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
    return (
      url.protocol === "https:" &&
      baseUrl.protocol === "https:" &&
      url.origin === baseUrl.origin &&
      (url.pathname === baseUrl.pathname || url.pathname.startsWith(basePath))
    );
  } catch {
    return false;
  }
}

export type PlatformMediaUploadSigner = {
  signUploadTarget(input: {
    sessionId: string;
    uploadTargetId: string;
    stagingKey: string;
    contentType: string;
    sizeBytes: number;
    expiresAt: string;
  }): Promise<Omit<PlatformMediaUploadTarget, "clientFileId" | "stagingKey">>;
};

export type PlatformMediaTargetResolver = {
  resolveTarget(input: {
    context: RequestContext;
    request: PlatformMediaUploadSessionRequest;
    policy: PlatformMediaPurposePolicy;
  }): Promise<
    | { ok: true; target: PlatformMediaResolvedTarget; ownerOrganizationId?: string }
    | { ok: false; statusCode: 400 | 403 | 404; code: string; message: string }
  >;
};

export type PlatformMediaUploadFinalizer = {
  inspectUploadedFile(input: {
    session: PlatformMediaSessionRecord;
    sessionFile: PlatformMediaSessionRecord["files"][number];
    uploadTarget: PlatformMediaUploadTarget;
    clientFile: PlatformMediaFinalizeFileRequest;
    policy: PlatformMediaPurposePolicy;
  }): Promise<
    | { ok: true; inspection: PlatformMediaFinalizedFileInspection }
    | { ok: false; code: string; message: string }
  >;
  generateVariants(input: {
    session: PlatformMediaSessionRecord;
    file: PlatformMediaFinalizedFileRecord;
    fileIndex: number;
    policy: PlatformMediaPurposePolicy;
  }): Promise<PlatformMediaVariantRecord[]>;
  cleanupUploadedFile?(input: {
    session: PlatformMediaSessionRecord;
    file: PlatformMediaFinalizedFileRecord;
  }): Promise<void>;
};

export type PlatformMediaRoutesOptions = {
  repository: PlatformMediaRepository;
  signer: PlatformMediaUploadSigner;
  targetResolver: PlatformMediaTargetResolver;
  finalizer: PlatformMediaUploadFinalizer;
  enabledPurposes: readonly PlatformMediaPurpose[];
  allowedOrigins?: string[];
  bucketName?: string;
  mediaPathPrefix?: string;
  cleanupTimeoutMs?: number;
  now?: () => Date;
};

export type PlatformMediaPurposePolicy = {
  purpose: PlatformMediaPurpose;
  permission?: PermissionKey;
  actorOwned?: boolean;
  allowedRelationships: readonly ResourceRelationship[];
  allowedResources: ReadonlyArray<Pick<LinkedResource, "product" | "resourceType">>;
  allowedContentTypes: readonly string[];
  allowedExtensions: readonly string[];
  maxFileSizeBytes: number;
  maxFileCount: number;
  maxImagePixels?: number;
  resizeOversizedPublicImages?: boolean;
  autoApprovePublicOnFinalize?: boolean;
  privateOnly: boolean;
  targetResourceProduct: PlatformMediaResourceProduct;
  targetResourceType: string;
  requiredVariants: readonly PlatformMediaVariantName[];
};

const imageContentTypes = ["image/jpeg", "image/png", "image/webp"] as const;
const imageExtensions = [".jpg", ".jpeg", ".png", ".webp"] as const;
const bookingHeaderLogoContentTypes = ["image/jpeg", "image/png", "image/svg+xml"] as const;
const bookingHeaderLogoExtensions = [".jpg", ".jpeg", ".png", ".svg"] as const;
const heicConversionMessage =
  "HEIC and HEIF profile photos are not supported yet. Convert the photo to JPG, PNG, or WebP and try again.";
const publicImageVariants = ["original_safe", "large", "thumbnail", "blur_preview"] as const;
const providerOriginalVariant = ["provider_original"] as const;
const defaultMaxImagePixels = 60_000_000;
const platformAdminMediaPurposes = new Set<PlatformMediaPurpose>([
  "property.hero_image",
  "marketplace.offer.media",
  "marketplace.creator.profile_image",
]);

export function isAutoApprovedPublicMediaPurpose(purpose: PlatformMediaPurpose): boolean {
  return (
    purpose === "identity.user.profile_image" ||
    purpose === "booking.header_logo" ||
    purpose === "booking.addon.image" ||
    purpose === "marketplace.creator.profile_image" ||
    purpose === "pms.room_type.media"
  );
}

const targetPurposePolicies: Record<PlatformMediaPurpose, PlatformMediaPurposePolicy> = {
  "identity.user.profile_image": {
    purpose: "identity.user.profile_image",
    actorOwned: true,
    allowedRelationships: [],
    allowedResources: [{ product: "platform", resourceType: "user_profile" }],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 5 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    autoApprovePublicOnFinalize: isAutoApprovedPublicMediaPurpose("identity.user.profile_image"),
    privateOnly: false,
    targetResourceProduct: "platform",
    targetResourceType: "user_profile",
    requiredVariants: publicImageVariants,
  },
  "booking.header_logo": {
    purpose: "booking.header_logo",
    permission: "booking.settings.manage",
    allowedRelationships: ["owner", "operator"],
    allowedResources: [{ product: "booking", resourceType: "booking_hotel" }],
    allowedContentTypes: bookingHeaderLogoContentTypes,
    allowedExtensions: bookingHeaderLogoExtensions,
    maxFileSizeBytes: 500 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    autoApprovePublicOnFinalize: isAutoApprovedPublicMediaPurpose("booking.header_logo"),
    privateOnly: false,
    targetResourceProduct: "booking",
    targetResourceType: "booking_hotel",
    requiredVariants: publicImageVariants,
  },
  "booking.addon.image": {
    purpose: "booking.addon.image",
    permission: "booking.settings.manage",
    allowedRelationships: ["owner", "operator"],
    allowedResources: [{ product: "booking", resourceType: "booking_hotel" }],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    autoApprovePublicOnFinalize: isAutoApprovedPublicMediaPurpose("booking.addon.image"),
    privateOnly: false,
    targetResourceProduct: "booking",
    targetResourceType: "booking_hotel",
    requiredVariants: publicImageVariants,
  },
  "property.hero_image": {
    purpose: "property.hero_image",
    permission: PROPERTY_MEDIA_AUTHORIZATION.permission,
    allowedRelationships: PROPERTY_MEDIA_AUTHORIZATION.allowedRelationships,
    allowedResources: [
      {
        product: PROPERTY_MEDIA_AUTHORIZATION.product,
        resourceType: PROPERTY_MEDIA_AUTHORIZATION.resourceType,
      },
    ],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: true,
    targetResourceProduct: "hotel_catalog",
    targetResourceType: "property",
    requiredVariants: publicImageVariants,
  },
  "property.gallery_image": {
    purpose: "property.gallery_image",
    permission: PROPERTY_MEDIA_AUTHORIZATION.permission,
    allowedRelationships: PROPERTY_MEDIA_AUTHORIZATION.allowedRelationships,
    allowedResources: [
      {
        product: PROPERTY_MEDIA_AUTHORIZATION.product,
        resourceType: PROPERTY_MEDIA_AUTHORIZATION.resourceType,
      },
    ],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 25,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: true,
    targetResourceProduct: "hotel_catalog",
    targetResourceType: "property",
    requiredVariants: publicImageVariants,
  },
  "property.logo": {
    purpose: "property.logo",
    permission: PROPERTY_MEDIA_AUTHORIZATION.permission,
    allowedRelationships: PROPERTY_MEDIA_AUTHORIZATION.allowedRelationships,
    allowedResources: [
      {
        product: PROPERTY_MEDIA_AUTHORIZATION.product,
        resourceType: PROPERTY_MEDIA_AUTHORIZATION.resourceType,
      },
    ],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: true,
    targetResourceProduct: "hotel_catalog",
    targetResourceType: "property",
    requiredVariants: publicImageVariants,
  },
  "marketplace.offer.media": {
    purpose: "marketplace.offer.media",
    permission: "marketplace.profile.manage",
    allowedRelationships: ["owner", "operator"],
    allowedResources: [{ product: "marketplace", resourceType: "marketplace_offer" }],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 12,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: false,
    targetResourceProduct: "marketplace",
    targetResourceType: "marketplace_offer",
    requiredVariants: publicImageVariants,
  },
  "marketplace.creator.profile_image": {
    purpose: "marketplace.creator.profile_image",
    permission: "marketplace.profile.manage",
    allowedRelationships: ["owner"],
    allowedResources: [{ product: "marketplace", resourceType: "creator_profile" }],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 5 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    autoApprovePublicOnFinalize: isAutoApprovedPublicMediaPurpose(
      "marketplace.creator.profile_image",
    ),
    privateOnly: false,
    targetResourceProduct: "marketplace",
    targetResourceType: "creator_profile",
    requiredVariants: publicImageVariants,
  },
  "marketplace.collaboration_chat.attachment": {
    purpose: "marketplace.collaboration_chat.attachment",
    permission: "marketplace.collaboration.write",
    allowedRelationships: ["owner", "operator"],
    allowedResources: [
      { product: "marketplace", resourceType: "marketplace_offer" },
      { product: "marketplace", resourceType: "creator_profile" },
    ],
    allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".gif"],
    maxFileSizeBytes: 20 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: true,
    targetResourceProduct: "marketplace",
    targetResourceType: "collaboration",
    requiredVariants: providerOriginalVariant,
  },
  "pms.room_type.media": {
    purpose: "pms.room_type.media",
    permission: PROPERTY_MEDIA_AUTHORIZATION.permission,
    allowedRelationships: PROPERTY_MEDIA_AUTHORIZATION.allowedRelationships,
    allowedResources: [
      {
        product: PROPERTY_MEDIA_AUTHORIZATION.product,
        resourceType: PROPERTY_MEDIA_AUTHORIZATION.resourceType,
      },
    ],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 20,
    maxImagePixels: defaultMaxImagePixels,
    resizeOversizedPublicImages: true,
    autoApprovePublicOnFinalize: isAutoApprovedPublicMediaPurpose("pms.room_type.media"),
    privateOnly: false,
    targetResourceProduct: "pms",
    targetResourceType: "room_type",
    requiredVariants: publicImageVariants,
  },
  "pms.messaging.attachment": {
    purpose: "pms.messaging.attachment",
    permission: "pms.operations.manage",
    allowedRelationships: ["owner", "operator", "front_desk"],
    allowedResources: [
      { product: "pms", resourceType: "pms_property" },
      { product: "pms", resourceType: "pms_hotel" },
    ],
    allowedContentTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/heic",
      "image/heif",
      "application/pdf",
    ],
    allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".pdf"],
    maxFileSizeBytes: 25 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: true,
    targetResourceProduct: "pms",
    targetResourceType: "message_thread",
    requiredVariants: providerOriginalVariant,
  },
  "pms.import.source_image": {
    purpose: "pms.import.source_image",
    permission: "pms.operations.manage",
    allowedRelationships: ["owner", "operator"],
    allowedResources: [
      { product: "pms", resourceType: "pms_property" },
      { product: "pms", resourceType: "pms_hotel" },
    ],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 20,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: true,
    targetResourceProduct: "pms",
    targetResourceType: "import_job",
    requiredVariants: providerOriginalVariant,
  },
  "finance.expense.receipt": {
    purpose: "finance.expense.receipt",
    permission: "pms.finance.manage",
    allowedRelationships: ["owner", "finance_manager"],
    allowedResources: [{ product: "pms", resourceType: "pms_property" }],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 20 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: true,
    targetResourceProduct: "finance",
    targetResourceType: "expense",
    requiredVariants: providerOriginalVariant,
  },
};

function policyForPurpose(purpose: PlatformMediaPurpose): PlatformMediaPurposePolicy {
  return targetPurposePolicies[purpose];
}

function policyForSession(
  session: Pick<PlatformMediaSessionRecord, "purpose" | "resource">,
): PlatformMediaPurposePolicy {
  return policyForPurpose(session.purpose);
}

export async function registerPlatformMediaRoutes(
  app: FastifyInstance,
  options: PlatformMediaRoutesOptions,
): Promise<void> {
  const bucketName = options.bucketName ?? "vayada-media-local";
  const mediaPathPrefix = normalizePlatformMediaPathPrefix(options.mediaPathPrefix ?? "media");
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
  const now = options.now ?? (() => new Date());
  app.addHook("onClose", async () => {
    await options.repository.close?.();
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Vary", "Origin");
    const origin = request.headers.origin;
    if (origin && options.allowedOrigins?.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
  });

  app.options("/*", async (_request, reply) => reply.status(204).send());

  app.post<{ Body: PlatformMediaUploadSessionRequest }>(
    "/upload-sessions",
    async (request, reply) => {
      const validation = validateUploadSessionRequest(request.body);
      if (!validation.ok) return sendMediaError(reply, 400, validation.code, validation.message);

      const policy = policyForPurpose(request.body.purpose);
      const resourceError = validateResourceScope(request.body.resource, policy);
      if (resourceError) {
        return sendMediaError(reply, 400, resourceError.code, resourceError.message);
      }

      const authorization = authorizeMediaResource(request, policy, request.body.resource);
      if (!authorization.ok) {
        return sendMediaError(reply, 403, "media_resource_forbidden", authorization.message);
      }
      const context = authorization.context;
      const isPlatformAdminMedia =
        context.selectedOrganization.kind === "platform" &&
        platformAdminMediaPurposes.has(policy.purpose);
      if (policy.actorOwned && request.body.resource.resourceId !== context.actor.internalUserId) {
        return sendMediaError(
          reply,
          403,
          "media_resource_forbidden",
          "Profile images can only be uploaded for the signed-in user.",
        );
      }
      if (
        policy.actorOwned &&
        (request.body.resource.targetResourceId !== undefined ||
          request.body.resource.propertyId !== undefined)
      ) {
        return sendMediaError(
          reply,
          400,
          "invalid_resource_scope",
          "Profile image targets cannot be overridden.",
        );
      }

      const requestedVisibility = request.body.visibility ?? "private";
      if (policy.autoApprovePublicOnFinalize && requestedVisibility !== "public") {
        return sendMediaError(
          reply,
          400,
          "invalid_media_visibility",
          `${request.body.purpose} uploads must be public.`,
        );
      }
      if (policy.privateOnly && requestedVisibility !== "private") {
        return sendMediaError(
          reply,
          400,
          "invalid_media_visibility",
          `${request.body.purpose} uploads must stay private.`,
        );
      }

      const filePolicyError = validateFiles(request.body.files, policy);
      if (filePolicyError) {
        return sendMediaError(reply, 400, filePolicyError.code, filePolicyError.message);
      }

      const createdAt = now().toISOString();
      const expiresAt = new Date(now().getTime() + 15 * 60 * 1000).toISOString();
      const idempotencyKey = request.body.idempotencyKey?.trim();
      const sessionId = idempotencyKey
        ? deterministicUploadSessionId(context, idempotencyKey, uploadContractVersion(request.body))
        : randomUUID();
      const uploadSessionKey = `media.upload_session:${sessionId}`;
      const stagingPrefix = `staging/${sessionId}`;
      const normalizedFiles = request.body.files.map((file, index) => ({
        ...file,
        filename: normalizeFilename(file.filename),
        contentType: normalizeUploadContentType(file.filename, file.contentType),
        clientFileId: file.clientFileId?.trim() || `file_${index + 1}`,
      }));
      const normalizedRequest: PlatformMediaUploadSessionRequest = {
        ...request.body,
        idempotencyKey,
        visibility: requestedVisibility,
        files: normalizedFiles,
      };
      const existingSession = idempotencyKey
        ? await options.repository.findUploadSession(sessionId)
        : null;
      if (existingSession?.status === "completed") {
        return sendUploadSessionReplay({
          reply,
          session: existingSession,
          expected: {
            context,
            uploadSessionKey,
            request: normalizedRequest,
            target: existingSession.target,
            ownerOrganizationId: existingSession.ownerOrganizationId,
          },
          signer: options.signer,
          repository: options.repository,
          now: now(),
          mediaPathPrefix,
        });
      }
      if (!existingSession && !isPurposeEnabled(options, request.body.purpose)) {
        return sendPurposeUnavailable(reply);
      }

      const resolvedTarget = await options.targetResolver.resolveTarget({
        context,
        request: request.body,
        policy,
      });
      if (!resolvedTarget.ok) {
        return sendMediaError(
          reply,
          resolvedTarget.statusCode,
          resolvedTarget.code,
          resolvedTarget.message,
        );
      }
      const ownerOrganizationId = isPlatformAdminMedia
        ? resolvedTarget.ownerOrganizationId
        : context.selectedOrganization.organizationId;
      if (!ownerOrganizationId) {
        return sendMediaError(
          reply,
          404,
          "media_target_not_found",
          "The requested admin media target is unavailable.",
        );
      }

      if (existingSession) {
        return sendUploadSessionReplay({
          reply,
          session: existingSession,
          expected: {
            context,
            uploadSessionKey,
            request: normalizedRequest,
            target: resolvedTarget.target,
            ownerOrganizationId,
          },
          signer: options.signer,
          repository: options.repository,
          now: now(),
          mediaPathPrefix,
        });
      }

      const files = normalizedFiles.map((file) => ({
        ...file,
        uploadTargetId: randomUUID(),
      }));
      const uploadTargets = await Promise.all(
        files.map(async (file, index) => {
          const stagingKey = `${stagingPrefix}/${index + 1}/${file.filename}`;
          const signed = await options.signer.signUploadTarget({
            sessionId,
            uploadTargetId: file.uploadTargetId,
            stagingKey,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            expiresAt,
          });
          return {
            ...signed,
            clientFileId: file.clientFileId,
            stagingKey,
          };
        }),
      );

      let session: PlatformMediaSessionRecord;
      try {
        session = await options.repository.createUploadSession({
          context,
          sessionId,
          uploadSessionKey,
          stagingPrefix,
          request: normalizedRequest,
          policy,
          target: resolvedTarget.target,
          ownerOrganizationId,
          platformAdmin: isPlatformAdminMedia,
          uploadTargets,
          now: createdAt,
          expiresAt,
          auditEvent: {
            action: "platform_media.upload_session.created",
            auditKey: uploadSessionKey,
            actorUserId: context.actor.internalUserId,
            organizationId: context.selectedOrganization.organizationId,
            targetType: "media_upload_session",
            targetId: sessionId,
            requestId: context.audit.requestId,
            metadata: {
              purpose: request.body.purpose,
              requestedVisibility,
              resource: request.body.resource,
              target: resolvedTarget.target,
              fileCount: files.length,
            },
          },
        });
      } catch (error) {
        if (error instanceof PlatformMediaPlanLimitError) {
          return sendMediaError(reply, 409, error.code, error.message);
        }
        throw error;
      }

      if (
        !uploadSessionMatchesRequest(session, {
          context,
          uploadSessionKey,
          request: normalizedRequest,
          target: resolvedTarget.target,
          ownerOrganizationId,
        })
      ) {
        return sendMediaError(
          reply,
          409,
          "upload_session_idempotency_conflict",
          "This idempotency key was already used for a different upload request.",
        );
      }
      const replayedConcurrentCreate =
        session.status !== "signed" ||
        session.uploadTargets.some(
          (target, index) => target.uploadTargetId !== uploadTargets[index]?.uploadTargetId,
        );
      if (replayedConcurrentCreate) {
        return sendUploadSessionReplay({
          reply,
          session,
          expected: {
            context,
            uploadSessionKey,
            request: normalizedRequest,
            target: resolvedTarget.target,
            ownerOrganizationId,
          },
          signer: options.signer,
          repository: options.repository,
          now: now(),
          mediaPathPrefix,
        });
      }

      reply.header("Cache-Control", "private, no-store");
      reply.header("Vary", "Origin, Authorization");
      return reply.code(201).send({
        contractVersion: uploadContractVersion(session),
        uploadSession: serializeSession(session),
        uploadTargets: serializeUploadTargets(session),
        audit: serializeAudit(context),
      });
    },
  );

  app.post<{ Body: PlatformMediaFinalizeRequest; Params: { sessionId: string } }>(
    "/upload-sessions/:sessionId/finalize",
    async (request, reply) => {
      const authenticatedContext = requireAuthContext(request);
      const platformOrganizationSelected =
        authenticatedContext.selectedOrganization.kind === "platform";
      const session = platformOrganizationSelected
        ? await options.repository.findUploadSession(request.params.sessionId)
        : await options.repository.findUploadSessionForActor({
            sessionId: request.params.sessionId,
            actorUserId: authenticatedContext.actor.internalUserId,
            ownerOrganizationId: authenticatedContext.selectedOrganization.organizationId,
          });
      if (!session || session.actorUserId !== authenticatedContext.actor.internalUserId) {
        return sendMediaError(reply, 404, "upload_session_not_found", "Upload session not found.");
      }
      const policy = policyForSession(session);
      const resourceError = validateResourceScope(session.resource, policy);
      if (resourceError || !sessionVisibilityMatchesPolicy(session, policy)) {
        return sendNonReusableUploadSession(reply);
      }
      const authorization = authorizeMediaResource(request, policy, session.resource);
      if (!authorization.ok) {
        return sendMediaError(reply, 403, "media_resource_forbidden", authorization.message);
      }
      const context = authorization.context;
      if (session.platformAdmin && context.selectedOrganization.kind !== "platform") {
        return sendMediaError(
          reply,
          403,
          "media_resource_forbidden",
          "Platform Admin media must be finalized from the platform organization.",
        );
      }
      if (policy.actorOwned && session.resource.resourceId !== context.actor.internalUserId) {
        return sendMediaError(
          reply,
          403,
          "media_resource_forbidden",
          "Profile images can only be finalized by the signed-in user.",
        );
      }
      if (session.status === "completed") {
        await cleanupUploadedFiles({
          finalizer: options.finalizer,
          session,
          files: finalizedFilesFromCompletedSession(session),
          timeoutMs: cleanupTimeoutMs,
          onError(error, file) {
            request.log.warn(
              {
                err: error,
                sessionId: session.sessionId,
                uploadTargetId: file.uploadTarget.uploadTargetId,
              },
              "Platform media staging cleanup failed; a finalize replay will retry it.",
            );
          },
        });
        return sendCompletedFinalizeReplay(reply, session, mediaPathPrefix);
      }
      const currentTarget = await options.targetResolver.resolveTarget({
        context,
        request: uploadRequestFromSession(session),
        policy,
      });
      if (
        !currentTarget.ok ||
        (session.platformAdmin
          ? currentTarget.ownerOrganizationId
          : context.selectedOrganization.organizationId) !== session.ownerOrganizationId ||
        JSON.stringify(targetProjection(currentTarget.target)) !==
          JSON.stringify(targetProjection(session.target))
      ) {
        return sendNonReusableUploadSession(reply);
      }
      if (new Date(session.expiresAt).getTime() <= now().getTime()) {
        return sendMediaError(reply, 409, "upload_session_expired", "Upload session expired.");
      }
      const finalizationSession =
        session.requestedVisibility === "public" && policy.autoApprovePublicOnFinalize === true
          ? { ...session, effectiveVisibility: "public" as const }
          : session;
      const validation = validateFinalizeRequest(request.body, finalizationSession);
      if (!validation.ok) return sendMediaError(reply, 400, validation.code, validation.message);

      const finalizedFiles = await inspectFinalizedFiles({
        request: request.body,
        session: finalizationSession,
        policy,
        finalizer: options.finalizer,
      });
      if (!finalizedFiles.ok) {
        const replay = await findCompletedFinalizeReplay({
          repository: options.repository,
          session,
        });
        if (replay) return sendCompletedFinalizeReplay(reply, replay, mediaPathPrefix);
        return sendMediaError(reply, 400, finalizedFiles.code, finalizedFiles.message);
      }

      const variantSets: PlatformMediaVariantRecord[][] = [];
      try {
        for (const [index, file] of finalizedFiles.files.entries()) {
          variantSets.push(
            await options.finalizer.generateVariants({
              session: finalizationSession,
              file,
              fileIndex: index,
              policy,
            }),
          );
        }
      } catch (error) {
        if (error instanceof PlatformMediaStagingChangedError) {
          const replay = await findCompletedFinalizeReplay({
            repository: options.repository,
            session,
          });
          if (replay) return sendCompletedFinalizeReplay(reply, replay, mediaPathPrefix);
          return sendNonReusableUploadSession(reply);
        }
        throw error;
      }
      const completedAt = now().toISOString();
      let completed: PlatformMediaCompleteUploadSessionResult;
      try {
        completed = await options.repository.completeUploadSession({
          session: finalizationSession,
          files: finalizedFiles.files,
          variantSets,
          bucketName,
          now: completedAt,
          auditEvent: {
            action: "platform_media.upload_session.finalized",
            auditKey: `media.finalize:${session.sessionId}`,
            actorUserId: finalizationSession.actorUserId,
            organizationId: finalizationSession.ownerOrganizationId,
            targetType: "media_object",
            targetId: finalizationSession.files[0]!.mediaId,
            requestId: context.audit.requestId,
            metadata: {
              purpose: finalizationSession.purpose,
              requestedVisibility: finalizationSession.requestedVisibility,
              effectiveVisibility: finalizationSession.effectiveVisibility,
              target: finalizationSession.target,
              mediaIds: finalizationSession.files.map(({ mediaId }) => mediaId),
              variantNames: variantSets[0]?.map(({ variantName }) => variantName) ?? [],
            },
          },
        });
      } catch (error) {
        if (error instanceof PlatformMediaTargetInvalidError) {
          return sendNonReusableUploadSession(reply);
        }
        throw error;
      }
      const completedSession = completed.uploadSession;
      const mediaObjects = completed.mediaObjects;
      const primaryMediaObject = mediaObjects[0]!;
      await cleanupUploadedFiles({
        finalizer: options.finalizer,
        session: completedSession,
        files: finalizedFiles.files,
        timeoutMs: cleanupTimeoutMs,
        onError(error, file) {
          request.log.warn(
            {
              err: error,
              sessionId: completedSession.sessionId,
              uploadTargetId: file.uploadTarget.uploadTargetId,
            },
            "Platform media staging cleanup failed; a finalize replay will retry it.",
          );
        },
      });

      setPrivateMediaResponseHeaders(reply, completedSession);
      return reply.code(200).send({
        contractVersion: uploadContractVersion(completedSession),
        uploadSession: serializeSession(completedSession),
        mediaObject: serializeMediaObject(completedSession, primaryMediaObject, mediaPathPrefix),
        mediaObjects: mediaObjects.map((mediaObject) =>
          serializeMediaObject(completedSession, mediaObject, mediaPathPrefix),
        ),
        sideEffects: ["variant_generation", "audit_event"],
      });
    },
  );

  app.post<{ Body: PlatformMediaImportRequest }>("/imports", async (request, reply) => {
    const validation = validateImportRequest(request.body);
    if (!validation.ok) return sendMediaError(reply, 400, validation.code, validation.message);
    if (!isPurposeEnabled(options, request.body.purpose)) {
      return sendPurposeUnavailable(reply);
    }

    const policy = targetPurposePolicies[request.body.purpose];
    const resourceError = validateResourceScope(request.body.resource, policy);
    if (resourceError) {
      return sendMediaError(reply, 400, resourceError.code, resourceError.message);
    }

    const context = enforceRoutePolicy(request, {
      permission: permissionForResource(policy),
      resource: {
        product: request.body.resource.product,
        resourceType: request.body.resource.resourceType,
        resourceId: request.body.resource.resourceId,
        allowedRelationships: policy.allowedRelationships,
      },
    });

    const resolvedTarget = await options.targetResolver.resolveTarget({
      context,
      request: {
        ...request.body,
        visibility: "private",
        files: request.body.sourceImageUrls.map((sourceImageUrl, index) => ({
          clientFileId: `source_${index + 1}`,
          filename: sourceFilename(sourceImageUrl, index),
          contentType: "image/jpeg",
          sizeBytes: 1,
        })),
      },
      policy,
    });
    if (!resolvedTarget.ok) {
      return sendMediaError(
        reply,
        resolvedTarget.statusCode,
        resolvedTarget.code,
        resolvedTarget.message,
      );
    }

    const createdAt = now().toISOString();
    const importJobId = randomUUID();
    const jobKey =
      request.body.idempotencyKey?.trim() ||
      `media.import:pms:${request.body.resource.targetResourceId ?? request.body.resource.resourceId}:${importJobId}:v1`;
    const importJob = await options.repository.createImportJob({
      context,
      importJobId,
      jobKey,
      request: request.body,
      policy,
      target: resolvedTarget.target,
      now: createdAt,
    });

    await options.repository.recordAudit({
      action: "platform_media.import_job.created",
      auditKey: jobKey,
      actorUserId: context.actor.internalUserId,
      organizationId: context.selectedOrganization.organizationId,
      targetType: "media_import_job",
      targetId: importJob.importJobId,
      requestId: context.audit.requestId,
      metadata: {
        purpose: importJob.purpose,
        sourceImageCount: importJob.sourceImageUrls.length,
        resource: importJob.resource,
        target: importJob.target,
      },
    });

    return reply.code(202).send({
      contractVersion: PLATFORM_MEDIA_IMPORT_CONTRACT_VERSION,
      importJob: serializeImportJob(importJob),
      sideEffects: ["media_import_job_created", "audit_event"],
      audit: serializeAudit(context),
    });
  });
}

function setPrivateMediaResponseHeaders(
  reply: FastifyReply,
  session: PlatformMediaSessionRecord,
): void {
  if (session.effectiveVisibility !== "private") return;
  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Origin, Authorization");
}

type ExpectedUploadSession = {
  context: RequestContext;
  uploadSessionKey: string;
  request: PlatformMediaUploadSessionRequest;
  target: PlatformMediaResolvedTarget;
  ownerOrganizationId: string;
};

function deterministicUploadSessionId(
  context: RequestContext,
  idempotencyKey: string,
  contractVersion:
    | typeof PLATFORM_MEDIA_UPLOAD_CONTRACT_VERSION
    | typeof CANONICAL_HOTEL_MEDIA_UPLOAD_CONTRACT_VERSION,
): string {
  const bytes = createHash("sha256")
    .update(
      JSON.stringify([
        contractVersion,
        context.actor.internalUserId,
        context.selectedOrganization.organizationId,
        idempotencyKey,
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

function uploadSessionMatchesRequest(
  session: PlatformMediaSessionRecord,
  expected: ExpectedUploadSession,
): boolean {
  return (
    session.uploadSessionKey === expected.uploadSessionKey &&
    session.actorUserId === expected.context.actor.internalUserId &&
    session.ownerOrganizationId === expected.ownerOrganizationId &&
    session.purpose === expected.request.purpose &&
    session.requestedVisibility === (expected.request.visibility ?? "private") &&
    JSON.stringify(resourceProjection(session.resource)) ===
      JSON.stringify(resourceProjection(expected.request.resource)) &&
    JSON.stringify(targetProjection(session.target)) ===
      JSON.stringify(targetProjection(expected.target)) &&
    JSON.stringify(session.files.map(fileProjection)) ===
      JSON.stringify(expected.request.files.map(fileProjection))
  );
}

function uploadRequestFromSession(
  session: PlatformMediaSessionRecord,
): PlatformMediaUploadSessionRequest {
  return {
    purpose: session.purpose,
    visibility: session.requestedVisibility,
    resource: session.resource,
    files: session.files.map(({ clientFileId, filename, contentType, sizeBytes }) => ({
      clientFileId,
      filename,
      contentType,
      sizeBytes,
    })),
  };
}

function sessionVisibilityMatchesPolicy(
  session: PlatformMediaSessionRecord,
  policy: PlatformMediaPurposePolicy,
): boolean {
  if (policy.privateOnly) {
    return session.requestedVisibility === "private" && session.effectiveVisibility === "private";
  }
  if (policy.autoApprovePublicOnFinalize) {
    return session.requestedVisibility === "public" && session.effectiveVisibility === "public";
  }
  return session.effectiveVisibility === "private";
}

function resourceProjection(
  resource: PlatformMediaResourceScope,
): Record<string, string | undefined> {
  return {
    product: resource.product,
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    propertyId: resource.propertyId,
    targetResourceId: resource.targetResourceId,
  };
}

function targetProjection(target: PlatformMediaResolvedTarget): Record<string, string | undefined> {
  return {
    resourceProduct: target.resourceProduct,
    resourceType: target.resourceType,
    resourceId: target.resourceId,
    propertyId: target.propertyId,
  };
}

function fileProjection(
  file: PlatformMediaUploadFileRequest & { clientFileId?: string },
): Record<string, string | number> {
  return {
    clientFileId: file.clientFileId?.trim() ?? "",
    filename: normalizeFilename(file.filename),
    contentType: normalizeContentType(file.contentType),
    sizeBytes: file.sizeBytes,
  };
}

async function sendUploadSessionReplay(input: {
  reply: FastifyReply;
  session: PlatformMediaSessionRecord;
  expected: ExpectedUploadSession;
  signer: PlatformMediaUploadSigner;
  repository: PlatformMediaRepository;
  now: Date;
  mediaPathPrefix: string;
}): Promise<FastifyReply> {
  const { reply } = input;
  let session = input.session;
  if (!uploadSessionMatchesRequest(session, input.expected)) {
    return sendMediaError(
      reply,
      409,
      "upload_session_idempotency_conflict",
      "This idempotency key was already used for a different upload request.",
    );
  }
  if (session.status === "signed" && new Date(session.expiresAt).getTime() <= input.now.getTime()) {
    session = await input.repository.renewSignedUploadSession({
      session,
      expiresAt: new Date(input.now.getTime() + 15 * 60 * 1000).toISOString(),
      now: input.now.toISOString(),
    });
  }
  if (session.status === "failed") {
    return sendMediaError(
      reply,
      409,
      "upload_session_not_reusable",
      "The existing upload session cannot be reused.",
    );
  }

  const uploadTargets =
    session.status === "signed"
      ? await Promise.all(
          session.files.map(async (file) => {
            const target = session.uploadTargets.find(
              ({ uploadTargetId }) => uploadTargetId === file.uploadTargetId,
            );
            if (!target) throw new Error("Platform media upload session target is missing");
            const signed = await input.signer.signUploadTarget({
              sessionId: session.sessionId,
              uploadTargetId: target.uploadTargetId,
              stagingKey: target.stagingKey,
              contentType: file.contentType,
              sizeBytes: file.sizeBytes,
              expiresAt: session.expiresAt,
            });
            return {
              ...signed,
              clientFileId: file.clientFileId,
              stagingKey: target.stagingKey,
            };
          }),
        )
      : [];
  const mediaObjects =
    session.status === "completed"
      ? reusableCompletedMediaObjects(session, input.mediaPathPrefix)
      : undefined;
  if (session.status === "completed" && !mediaObjects) {
    return sendNonReusableUploadSession(reply);
  }

  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Origin, Authorization");
  return reply.code(200).send({
    contractVersion: uploadContractVersion(session),
    uploadSession: serializeSession(session),
    uploadTargets: serializeUploadTargets({ ...session, uploadTargets }),
    ...(mediaObjects
      ? {
          mediaObjects: mediaObjects.map((mediaObject) =>
            serializeMediaObject(session, mediaObject, input.mediaPathPrefix),
          ),
        }
      : {}),
    sideEffects: ["idempotency_replay"],
    audit: serializeAudit(input.expected.context),
  });
}

export function createDeterministicPlatformMediaUploadSigner(
  baseUrl = "https://uploads.vayada.localhost",
): PlatformMediaUploadSigner {
  return {
    async signUploadTarget(input) {
      return {
        uploadTargetId: input.uploadTargetId,
        method: "PUT",
        uploadUrl: `${baseUrl}/${encodeURIComponent(input.stagingKey)}`,
        headers: {
          "content-type": input.contentType,
          "x-vayada-upload-target-id": input.uploadTargetId,
        },
        expiresAt: input.expiresAt,
      };
    },
  };
}

export function createDeterministicPlatformMediaFinalizer(
  overrides: Partial<PlatformMediaFinalizedFileInspection> = {},
  mediaPathPrefix = "media",
): PlatformMediaUploadFinalizer {
  const normalizedPathPrefix = normalizePlatformMediaPathPrefix(mediaPathPrefix);
  return {
    async inspectUploadedFile(input) {
      return {
        ok: true,
        inspection: {
          contentType: input.sessionFile.contentType,
          sizeBytes: input.sessionFile.sizeBytes,
          checksumSha256:
            input.clientFile.checksumSha256 ??
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          widthPx: isImageContentType(input.sessionFile.contentType)
            ? (input.clientFile.widthPx ?? 1800)
            : undefined,
          heightPx: isImageContentType(input.sessionFile.contentType)
            ? (input.clientFile.heightPx ?? 1200)
            : undefined,
          ...overrides,
        },
      };
    },
    async generateVariants(input) {
      return input.policy.requiredVariants.map((variantName) => {
        const dimensions = resizedVariantDimensions(
          variantName,
          input.file.inspection.widthPx,
          input.file.inspection.heightPx,
        );
        const checksumSha256 = createHash("sha256")
          .update(
            [
              input.file.sessionFile.mediaId,
              variantName,
              input.file.inspection.checksumSha256 ?? "",
            ].join(":"),
          )
          .digest("hex");
        const extension = variantName === "provider_original" ? "bin" : "webp";
        const storageKey = `${input.session.effectiveVisibility}/${normalizedPathPrefix}/${input.file.sessionFile.mediaId}/${variantName}/sha256-${checksumSha256}.${extension}`;
        return {
          variantName,
          visibility: input.session.effectiveVisibility,
          storageKey,
          contentType:
            variantName === "provider_original"
              ? normalizeContentType(input.file.inspection.contentType)
              : "image/webp",
          widthPx: dimensions?.widthPx,
          heightPx: dimensions?.heightPx,
          sizeBytes: resizedVariantSize(input.file.inspection, dimensions),
          checksumSha256,
          publicCdnUrl:
            input.session.effectiveVisibility === "public"
              ? `https://cdn.vayada.localhost/${storageKey}`
              : null,
        };
      });
    },
  };
}

export function createInMemoryPlatformMediaRepository(): PlatformMediaRepository & {
  sessions: Map<string, PlatformMediaSessionRecord>;
  importJobs: Map<string, PlatformMediaImportJobRecord>;
  auditEvents: PlatformMediaAuditEvent[];
} {
  const sessions = new Map<string, PlatformMediaSessionRecord>();
  const importJobs = new Map<string, PlatformMediaImportJobRecord>();
  const auditEvents: PlatformMediaAuditEvent[] = [];

  return {
    sessions,
    importJobs,
    auditEvents,
    async createUploadSession(input) {
      const existing = sessions.get(input.sessionId);
      if (existing) return existing;

      const requestedVisibility = input.request.visibility ?? "private";
      const session: PlatformMediaSessionRecord = {
        sessionId: input.sessionId,
        uploadSessionKey: input.uploadSessionKey,
        purpose: input.request.purpose,
        requestedVisibility,
        effectiveVisibility:
          requestedVisibility === "public" && input.policy.autoApprovePublicOnFinalize === true
            ? "public"
            : "private",
        actorUserId: input.context.actor.internalUserId,
        ownerOrganizationId: input.ownerOrganizationId,
        platformAdmin: input.platformAdmin ? true : undefined,
        resource: input.request.resource,
        target: input.target,
        files: input.request.files.map((file, index) => ({
          ...file,
          clientFileId: file.clientFileId?.trim() || `file_${index + 1}`,
          uploadTargetId: input.uploadTargets[index]!.uploadTargetId,
          mediaId: randomUUID(),
        })),
        uploadTargets: input.uploadTargets,
        stagingPrefix: input.stagingPrefix,
        status: "signed",
        expiresAt: input.expiresAt,
        createdAt: input.now,
      };
      sessions.set(session.sessionId, session);
      recordInMemoryAudit(auditEvents, input.auditEvent);
      return session;
    },
    async findUploadSession(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async findUploadSessionForActor(input) {
      const session = sessions.get(input.sessionId);
      return session?.actorUserId === input.actorUserId &&
        session.ownerOrganizationId === input.ownerOrganizationId
        ? session
        : null;
    },
    async renewSignedUploadSession(input) {
      const current = sessions.get(input.session.sessionId);
      if (!current) throw new Error("Platform media upload session was not found");
      if (current.status !== "signed" || current.expiresAt !== input.session.expiresAt) {
        return current;
      }
      const renewed = {
        ...current,
        expiresAt: input.expiresAt,
        uploadTargets: current.uploadTargets.map((target) => ({
          ...target,
          expiresAt: input.expiresAt,
        })),
      };
      sessions.set(renewed.sessionId, renewed);
      return renewed;
    },
    async findMediaObject(mediaId) {
      for (const session of sessions.values()) {
        const mediaObject = (session.completedMediaObjects ?? []).find(
          (candidate) => candidate.mediaId === mediaId,
        );
        if (mediaObject) return mediaObject;
      }
      return null;
    },
    async completeUploadSession(input) {
      const autoApproved =
        input.session.requestedVisibility === "public" &&
        input.session.effectiveVisibility === "public";
      const effectiveVisibility = autoApproved ? "public" : input.session.effectiveVisibility;
      const mediaObjects = input.files.map((finalized, index) => {
        const sessionFile = finalized.sessionFile;
        const variants = input.variantSets[index]!.map((variant) => ({
          ...variant,
          visibility: effectiveVisibility,
        }));
        const canonicalVariant =
          variants.find(({ variantName }) => variantName === "original_safe") ??
          variants.find(({ variantName }) => variantName === "provider_original");
        if (!canonicalVariant) throw new Error("Platform media requires a canonical variant");
        return {
          mediaId: sessionFile.mediaId,
          purpose: input.session.purpose,
          visibility: effectiveVisibility,
          requestedVisibility: input.session.requestedVisibility,
          approvalStatus: autoApproved
            ? "approved"
            : input.session.requestedVisibility === "public"
              ? "pending_domain_approval"
              : "private",
          lifecycleStatus:
            autoApproved || input.session.purpose === "marketplace.collaboration_chat.attachment"
              ? "active"
              : "staged",
          storageKind: "vayada_managed",
          bucket: input.bucketName,
          storageKey: canonicalVariant.storageKey,
          ownerOrganizationId: input.session.ownerOrganizationId,
          actorUserId: input.session.actorUserId,
          resourceProduct: input.session.target.resourceProduct,
          resourceType: input.session.target.resourceType,
          resourceId: input.session.target.resourceId,
          propertyId: input.session.target.propertyId,
          contentType: canonicalVariant.contentType,
          sizeBytes: canonicalVariant.sizeBytes,
          checksumSha256: canonicalVariant.checksumSha256,
          widthPx: canonicalVariant.widthPx,
          heightPx: canonicalVariant.heightPx,
          originalFilename: sessionFile.filename,
          retainedUntil:
            input.session.purpose === "marketplace.collaboration_chat.attachment" ||
            input.session.purpose === "finance.expense.receipt"
              ? new Date(Date.parse(input.now) + 60 * 60 * 1000).toISOString()
              : null,
          variants,
          createdAt: input.now,
        } satisfies PlatformMediaObjectRecord;
      });
      const uploadSession: PlatformMediaSessionRecord = {
        ...input.session,
        effectiveVisibility,
        status: "completed",
        completedAt: input.now,
        completedMediaObjects: mediaObjects,
        completedMediaObject: mediaObjects[0],
      };
      sessions.set(uploadSession.sessionId, uploadSession);
      recordInMemoryAudit(auditEvents, input.auditEvent);
      return { uploadSession, mediaObjects };
    },
    async createImportJob(input) {
      const existing = [...importJobs.values()].find(
        ({ jobKey, ownerOrganizationId }) =>
          jobKey === input.jobKey &&
          ownerOrganizationId === input.context.selectedOrganization.organizationId,
      );
      if (existing) return existing;

      const importJob: PlatformMediaImportJobRecord = {
        importJobId: input.importJobId,
        jobKey: input.jobKey,
        purpose: input.request.purpose,
        status: "pending",
        actorUserId: input.context.actor.internalUserId,
        ownerOrganizationId: input.context.selectedOrganization.organizationId,
        sourceImageUrls: input.request.sourceImageUrls,
        resource: input.request.resource,
        target: input.target,
        createdAt: input.now,
      };
      importJobs.set(importJob.importJobId, importJob);
      return importJob;
    },
    async recordAudit(event) {
      recordInMemoryAudit(auditEvents, event);
    },
  };
}

function recordInMemoryAudit(
  auditEvents: PlatformMediaAuditEvent[],
  event: PlatformMediaAuditEvent,
): void {
  if (
    !auditEvents.some(
      ({ auditKey, action, organizationId }) =>
        auditKey === event.auditKey &&
        action === event.action &&
        organizationId === event.organizationId,
    )
  ) {
    auditEvents.push(event);
  }
}

function validateUploadSessionRequest(
  body: PlatformMediaUploadSessionRequest | undefined,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, code: "invalid_upload_request", message: "Request body is required." };
  }
  if (!isMediaPurpose(body.purpose)) {
    return { ok: false, code: "invalid_media_purpose", message: "Unsupported media purpose." };
  }
  if (
    body.idempotencyKey !== undefined &&
    (typeof body.idempotencyKey !== "string" ||
      body.idempotencyKey.trim().length === 0 ||
      body.idempotencyKey.trim().length > 512)
  ) {
    return {
      ok: false,
      code: "invalid_idempotency_key",
      message: "idempotencyKey must contain between 1 and 512 characters.",
    };
  }
  if (
    body.visibility !== undefined &&
    body.visibility !== "public" &&
    body.visibility !== "private"
  ) {
    return { ok: false, code: "invalid_media_visibility", message: "Unsupported visibility." };
  }
  if (!body.resource || typeof body.resource !== "object") {
    return { ok: false, code: "invalid_resource_scope", message: "Resource scope is required." };
  }
  if ("expectedProfileRevision" in body) {
    return {
      ok: false,
      code: "invalid_profile_revision",
      message: "Media assignment revisions belong on assignment commands, not upload sessions.",
    };
  }
  if (!Array.isArray(body.files) || body.files.length === 0) {
    return { ok: false, code: "invalid_upload_files", message: "At least one file is required." };
  }
  return { ok: true };
}

function validateImportRequest(
  body: PlatformMediaImportRequest | undefined,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, code: "invalid_import_request", message: "Request body is required." };
  }
  if (body.purpose !== "pms.import.source_image") {
    return { ok: false, code: "invalid_media_purpose", message: "Unsupported media purpose." };
  }
  if (!body.resource || typeof body.resource !== "object") {
    return { ok: false, code: "invalid_resource_scope", message: "Resource scope is required." };
  }
  if (!Array.isArray(body.sourceImageUrls) || body.sourceImageUrls.length === 0) {
    return {
      ok: false,
      code: "invalid_import_sources",
      message: "At least one source image URL is required.",
    };
  }
  const policy = targetPurposePolicies["pms.import.source_image"];
  if (body.sourceImageUrls.length > policy.maxFileCount) {
    return {
      ok: false,
      code: "media_file_count_exceeded",
      message: `${policy.purpose} accepts at most ${policy.maxFileCount} source URL(s).`,
    };
  }
  for (const sourceImageUrl of body.sourceImageUrls) {
    if (typeof sourceImageUrl !== "string" || !isSupportedSourceImageUrl(sourceImageUrl)) {
      return {
        ok: false,
        code: "invalid_import_source_url",
        message: "Each source image URL must be an http(s) URL with a supported image extension.",
      };
    }
  }
  if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") {
    return {
      ok: false,
      code: "invalid_import_request",
      message: "idempotencyKey must be a string.",
    };
  }
  return { ok: true };
}

function authorizeMediaResource(
  request: FastifyRequest,
  policy: PlatformMediaPurposePolicy,
  resource: PlatformMediaResourceScope,
): { ok: true; context: RequestContext } | { ok: false; message: string } {
  const authenticatedContext = requireAuthContext(request);
  if (
    authenticatedContext.selectedOrganization.kind === "platform" &&
    platformAdminMediaPurposes.has(policy.purpose)
  ) {
    return {
      ok: true,
      context: enforceRoutePolicy(request, {
        permission: "platform.user.suspend",
        resource: {
          product: "platform",
          resourceType: "platform",
          resourceId: "vayada",
          allowedRelationships: ["operator"],
        },
      }),
    };
  }
  if (policy.actorOwned) {
    return { ok: true, context: authenticatedContext };
  }
  if (policy.purpose === "finance.expense.receipt") {
    const permission = permissionForResource(policy);
    const requirement = {
      product: resource.product,
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
      allowedRelationships: policy.allowedRelationships,
    };
    let context = enforceRoutePolicy(request, { permission, resource: requirement });
    if (context.selectedOrganization.kind !== "hotel_group") {
      return { ok: false, message: "Selected organization cannot upload Finance receipts." };
    }
    for (const key of ["property-management", "module:financials"]) {
      context = enforceRoutePolicy(request, {
        permission,
        resource: requirement,
        entitlement: {
          product: "pms",
          key,
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: resource.resourceId,
          },
        },
      });
    }
    return { ok: true, context };
  }
  if (policy.purpose !== "marketplace.collaboration_chat.attachment") {
    return {
      ok: true,
      context: enforceRoutePolicy(request, {
        permission: permissionForResource(policy),
        resource: {
          product: resource.product,
          resourceType: resource.resourceType,
          resourceId: resource.resourceId,
          allowedRelationships: policy.allowedRelationships,
        },
      }),
    };
  }

  const context = enforceRoutePolicy(request, {
    permission: permissionForResource(policy),
  });
  const collaborationPolicy =
    context.selectedOrganization.kind === "creator_workspace"
      ? MARKETPLACE_COLLABORATION_CREATOR_WRITE_POLICY
      : context.selectedOrganization.kind === "hotel_group"
        ? MARKETPLACE_COLLABORATION_HOTEL_WRITE_POLICY
        : null;
  if (!collaborationPolicy) {
    return { ok: false, message: "Selected organization cannot write marketplace chat." };
  }

  const expectedSource =
    collaborationPolicy.side === "creator"
      ? { resourceType: "creator_profile", relationship: "owner" }
      : { resourceType: "marketplace_offer", relationship: "operator" };
  const activeLinks = context.linkedResources.filter(
    (linked) => linked.status === "active" && linked.product === "marketplace",
  );
  const sourceIsExact = activeLinks.some(
    (linked) =>
      resource.product === "marketplace" &&
      resource.resourceType === expectedSource.resourceType &&
      linked.resourceType === expectedSource.resourceType &&
      linked.resourceId === resource.resourceId &&
      linked.relationship === expectedSource.relationship,
  );
  const hasRequiredLinks = collaborationPolicy.requiredResources.every((required) =>
    activeLinks.some(
      (linked) =>
        linked.resourceType === required.resourceType &&
        linked.relationship === required.relationship,
    ),
  );
  const creatorProfileLinks = activeLinks.filter(
    (linked) => linked.resourceType === "creator_profile" && linked.relationship === "owner",
  );
  if (
    !sourceIsExact ||
    !hasRequiredLinks ||
    (collaborationPolicy.side === "creator" && creatorProfileLinks.length !== 1)
  ) {
    return {
      ok: false,
      message: "Chat attachment source does not satisfy collaboration write access.",
    };
  }
  return { ok: true, context };
}

function permissionForResource(policy: PlatformMediaPurposePolicy): PermissionKey {
  if (!policy.permission) throw new Error(`${policy.purpose} does not use a role permission.`);
  return policy.permission;
}

function validateResourceScope(
  resource: PlatformMediaResourceScope,
  policy: PlatformMediaPurposePolicy,
): { code: string; message: string } | null {
  if (typeof resource.product !== "string" || typeof resource.resourceType !== "string") {
    return {
      code: "invalid_resource_scope",
      message: "resource.product and resource.resourceType are required.",
    };
  }
  if (typeof resource.resourceId !== "string" || !resource.resourceId.trim()) {
    return { code: "invalid_resource_scope", message: "resource.resourceId is required." };
  }
  if (resource.propertyId !== undefined && typeof resource.propertyId !== "string") {
    return { code: "invalid_resource_scope", message: "resource.propertyId must be a string." };
  }
  if (resource.targetResourceId !== undefined && typeof resource.targetResourceId !== "string") {
    return {
      code: "invalid_resource_scope",
      message: "resource.targetResourceId must be a string.",
    };
  }
  const allowed = policy.allowedResources.some(
    (candidate) =>
      candidate.product === resource.product && candidate.resourceType === resource.resourceType,
  );
  if (!allowed) {
    return {
      code: "invalid_resource_scope",
      message: `${policy.purpose} cannot be uploaded for ${resource.product}:${resource.resourceType}.`,
    };
  }
  if (
    policy.purpose === "finance.expense.receipt" &&
    (resource.propertyId !== resource.resourceId ||
      !canonicalUuid(resource.resourceId) ||
      !canonicalUuid(resource.targetResourceId))
  ) {
    return {
      code: "invalid_resource_scope",
      message: "Finance receipts require canonical property and expense targets.",
    };
  }
  if (isCanonicalHotelMediaPolicy(policy)) {
    if (resource.propertyId !== undefined && resource.propertyId !== resource.resourceId) {
      return {
        code: "invalid_resource_scope",
        message: "Property media must use the canonical property as its resource.",
      };
    }
    if (
      policy.purpose === "pms.room_type.media" &&
      (typeof resource.targetResourceId !== "string" || !resource.targetResourceId.trim())
    ) {
      return {
        code: "invalid_resource_scope",
        message: "Room media requires a room type target.",
      };
    }
    if (policy.purpose !== "pms.room_type.media" && resource.targetResourceId !== undefined) {
      return {
        code: "invalid_resource_scope",
        message: "Property presentation media cannot override its property target.",
      };
    }
  }
  return null;
}

function canonicalUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.toLowerCase() &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function isCanonicalHotelMediaPolicy(policy: PlatformMediaPurposePolicy): boolean {
  return (
    isPropertyMediaPurpose(policy.purpose) &&
    policy.allowedResources.some(
      (resource) =>
        resource.product === PROPERTY_MEDIA_AUTHORIZATION.product &&
        resource.resourceType === PROPERTY_MEDIA_AUTHORIZATION.resourceType,
    )
  );
}

function validateFiles(
  files: PlatformMediaUploadFileRequest[],
  policy: PlatformMediaPurposePolicy,
): { code: string; message: string } | null {
  if (files.length > policy.maxFileCount) {
    return {
      code: "media_file_count_exceeded",
      message: `${policy.purpose} accepts at most ${policy.maxFileCount} file(s).`,
    };
  }
  for (const file of files) {
    if (!file || typeof file !== "object") {
      return { code: "invalid_upload_files", message: "Each file must be an object." };
    }
    if (file.clientFileId !== undefined && typeof file.clientFileId !== "string") {
      return { code: "invalid_upload_files", message: "clientFileId must be a string." };
    }
    if (typeof file.filename !== "string" || !file.filename.trim()) {
      return { code: "invalid_media_filename", message: "filename is required." };
    }
    if (
      typeof file.contentType !== "string" ||
      !normalizeUploadContentType(file.filename, file.contentType)
    ) {
      if (isProfileImagePurpose(policy.purpose) && isHeicOrHeif(file.filename, "")) {
        return {
          code: "unsupported_media_type",
          message: heicConversionMessage,
        };
      }
      return { code: "unsupported_media_type", message: "contentType is required." };
    }
    if (!Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0) {
      return { code: "invalid_media_size", message: "sizeBytes must be greater than zero." };
    }
    if (file.sizeBytes > policy.maxFileSizeBytes) {
      return {
        code: "media_file_too_large",
        message: `${policy.purpose} files must be ${policy.maxFileSizeBytes} bytes or smaller.`,
      };
    }
    const normalizedContentType = normalizeUploadContentType(file.filename, file.contentType);
    if (!policy.allowedContentTypes.includes(normalizedContentType)) {
      if (
        isProfileImagePurpose(policy.purpose) &&
        isHeicOrHeif(file.filename, normalizedContentType)
      ) {
        return {
          code: "unsupported_media_type",
          message: heicConversionMessage,
        };
      }
      return { code: "unsupported_media_type", message: `${file.contentType} is not allowed.` };
    }
    const extension = filenameExtension(file.filename);
    if (!extension || !policy.allowedExtensions.includes(extension)) {
      if (
        isProfileImagePurpose(policy.purpose) &&
        isHeicOrHeif(file.filename, normalizedContentType)
      ) {
        return {
          code: "unsupported_media_extension",
          message: heicConversionMessage,
        };
      }
      return { code: "unsupported_media_extension", message: `${file.filename} is not allowed.` };
    }
    if (!contentTypeAllowsExtension(normalizedContentType, extension)) {
      return {
        code: "media_type_mismatch",
        message: "File extension must match the requested content type.",
      };
    }
  }
  return null;
}

function isHeicOrHeif(filename: string, contentType: string): boolean {
  return (
    contentType === "image/heic" ||
    contentType === "image/heif" ||
    [".heic", ".heif"].includes(filenameExtension(filename) ?? "")
  );
}

function isProfileImagePurpose(purpose: PlatformMediaPurpose): boolean {
  return (
    purpose === "identity.user.profile_image" || purpose === "marketplace.creator.profile_image"
  );
}

function normalizeUploadContentType(filename: string, contentType: string): string {
  const normalized = normalizeContentType(contentType);
  if (normalized) return normalized;
  const extension = filenameExtension(filename);
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return "";
}

function validateFinalizeRequest(
  body: PlatformMediaFinalizeRequest | undefined,
  session: PlatformMediaSessionRecord,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!body || !Array.isArray(body.files)) {
    return { ok: false, code: "invalid_finalize_request", message: "files are required." };
  }
  if (body.files.length !== session.files.length) {
    return {
      ok: false,
      code: "media_file_count_mismatch",
      message: "Finalize file count must match the upload session.",
    };
  }
  const knownTargets = new Set(session.files.map((file) => file.uploadTargetId));
  const seenTargets = new Set<string>();
  for (const file of body.files) {
    if (!file || typeof file !== "object") {
      return {
        ok: false,
        code: "invalid_finalize_request",
        message: "Each file must be an object.",
      };
    }
    if (typeof file.uploadTargetId !== "string" || !file.uploadTargetId.trim()) {
      return { ok: false, code: "unknown_upload_target", message: "uploadTargetId is required." };
    }
    if (!knownTargets.has(file.uploadTargetId)) {
      return { ok: false, code: "unknown_upload_target", message: "Unknown upload target." };
    }
    if (seenTargets.has(file.uploadTargetId)) {
      return {
        ok: false,
        code: "duplicate_upload_target",
        message: "Each upload target may be finalized once.",
      };
    }
    seenTargets.add(file.uploadTargetId);
    if (file.contentType !== undefined && typeof file.contentType !== "string") {
      return {
        ok: false,
        code: "unsupported_media_type",
        message: "Finalized contentType must be a string.",
      };
    }
    if (
      file.sizeBytes !== undefined &&
      (!Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0)
    ) {
      return {
        ok: false,
        code: "invalid_media_size",
        message: "Finalized sizeBytes must be greater than zero.",
      };
    }
    if (file.checksumSha256 !== undefined && !isSha256Hex(file.checksumSha256)) {
      return {
        ok: false,
        code: "invalid_media_checksum",
        message: "checksumSha256 must be a lowercase SHA-256 hex string.",
      };
    }
    if (
      (file.widthPx !== undefined && (!Number.isInteger(file.widthPx) || file.widthPx <= 0)) ||
      (file.heightPx !== undefined && (!Number.isInteger(file.heightPx) || file.heightPx <= 0))
    ) {
      return {
        ok: false,
        code: "invalid_media_dimensions",
        message: "Image dimensions must be positive integers when supplied.",
      };
    }
  }
  return { ok: true };
}

async function inspectFinalizedFiles(input: {
  request: PlatformMediaFinalizeRequest;
  session: PlatformMediaSessionRecord;
  policy: PlatformMediaPurposePolicy;
  finalizer: PlatformMediaUploadFinalizer;
}): Promise<
  | { ok: true; files: PlatformMediaFinalizedFileRecord[] }
  | { ok: false; code: string; message: string }
> {
  const files: PlatformMediaFinalizedFileRecord[] = [];
  for (const sessionFile of input.session.files) {
    const clientFile = input.request.files.find(
      (file) => file.uploadTargetId === sessionFile.uploadTargetId,
    )!;
    const uploadTarget = input.session.uploadTargets.find(
      (target) => target.uploadTargetId === sessionFile.uploadTargetId,
    )!;
    const inspected = await input.finalizer.inspectUploadedFile({
      session: input.session,
      sessionFile,
      uploadTarget,
      clientFile,
      policy: input.policy,
    });
    if (!inspected.ok) return inspected;
    const validation = validateFinalizedInspection(
      clientFile,
      sessionFile,
      inspected.inspection,
      input.policy,
    );
    if (validation) return validation;
    files.push({
      sessionFile,
      uploadTarget,
      inspection: {
        ...inspected.inspection,
        contentType: normalizeContentType(inspected.inspection.contentType),
      },
    });
  }
  return { ok: true, files };
}

function validateFinalizedInspection(
  clientFile: PlatformMediaFinalizeFileRequest,
  sessionFile: PlatformMediaSessionRecord["files"][number],
  inspection: PlatformMediaFinalizedFileInspection,
  policy: PlatformMediaPurposePolicy,
): { ok: false; code: string; message: string } | null {
  if (!Number.isInteger(inspection.sizeBytes) || inspection.sizeBytes <= 0) {
    return {
      ok: false,
      code: "invalid_media_size",
      message: "Inspected upload size must be greater than zero.",
    };
  }
  if (
    inspection.sizeBytes > sessionFile.sizeBytes ||
    inspection.sizeBytes > policy.maxFileSizeBytes
  ) {
    return {
      ok: false,
      code: "media_file_too_large",
      message: "Inspected upload cannot exceed the signed upload size.",
    };
  }
  const inspectedContentType = normalizeContentType(inspection.contentType);
  if (!policy.allowedContentTypes.includes(inspectedContentType)) {
    return {
      ok: false,
      code: "unsupported_media_type",
      message: "Inspected content type is not allowed.",
    };
  }
  if (inspectedContentType !== normalizeContentType(sessionFile.contentType)) {
    return {
      ok: false,
      code: "media_type_mismatch",
      message: "Inspected content type must match the signed upload target.",
    };
  }
  if (
    clientFile.contentType !== undefined &&
    normalizeContentType(clientFile.contentType) !== inspectedContentType
  ) {
    return {
      ok: false,
      code: "media_type_mismatch",
      message: "Finalized content type must match the inspected upload.",
    };
  }
  if (clientFile.sizeBytes !== undefined && clientFile.sizeBytes !== inspection.sizeBytes) {
    return {
      ok: false,
      code: "media_size_mismatch",
      message: "Finalized size must match the inspected upload.",
    };
  }
  if (clientFile.checksumSha256 !== undefined) {
    if (inspection.checksumSha256 === undefined) {
      return {
        ok: false,
        code: "finalizer_missing_inspected_checksum",
        message: "Inspected upload must include checksum when finalize checksum is supplied.",
      };
    }
    if (!isSha256Hex(inspection.checksumSha256)) {
      return {
        ok: false,
        code: "invalid_media_checksum",
        message: "Inspected checksum must be a lowercase SHA-256 hex string.",
      };
    }
    if (clientFile.checksumSha256 !== inspection.checksumSha256) {
      return {
        ok: false,
        code: "media_checksum_mismatch",
        message: "Finalized checksum must match the inspected upload.",
      };
    }
  }
  if (inspection.checksumSha256 !== undefined && !isSha256Hex(inspection.checksumSha256)) {
    return {
      ok: false,
      code: "invalid_media_checksum",
      message: "Inspected checksum must be a lowercase SHA-256 hex string.",
    };
  }
  if (
    (inspection.widthPx !== undefined &&
      (!Number.isInteger(inspection.widthPx) || inspection.widthPx <= 0)) ||
    (inspection.heightPx !== undefined &&
      (!Number.isInteger(inspection.heightPx) || inspection.heightPx <= 0))
  ) {
    return {
      ok: false,
      code: "invalid_media_dimensions",
      message: "Inspected image dimensions must be positive integers.",
    };
  }
  if (
    inspection.widthPx !== undefined &&
    inspection.heightPx !== undefined &&
    policy.maxImagePixels &&
    inspection.widthPx * inspection.heightPx > policy.maxImagePixels
  ) {
    return {
      ok: false,
      code: "invalid_media_dimensions",
      message: "Inspected image dimensions exceed the platform media limit.",
    };
  }
  return null;
}

function serializeSession(session: PlatformMediaSessionRecord): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    purpose: session.purpose,
    requestedVisibility: session.requestedVisibility,
    effectiveVisibility: session.effectiveVisibility,
    status: session.status,
    expiresAt: session.expiresAt,
    resource: session.resource,
    target: session.target,
    fileCount: session.files.length,
  };
}

function serializeUploadTargets(
  session: Pick<PlatformMediaSessionRecord, "purpose" | "resource" | "uploadTargets">,
): Array<Omit<PlatformMediaUploadTarget, "stagingKey"> | PlatformMediaUploadTarget> {
  if (!isCanonicalHotelMediaSession(session)) return session.uploadTargets;
  return session.uploadTargets.map(({ stagingKey: _stagingKey, ...target }) => target);
}

function serializeMediaObject(
  session: Pick<PlatformMediaSessionRecord, "purpose" | "resource">,
  mediaObject: PlatformMediaObjectRecord,
  mediaPathPrefix: string,
): PlatformMediaObjectRecord | PropertyMediaLibraryItem | FinanceReceiptMediaItem {
  if (session.purpose === "finance.expense.receipt") {
    if (mediaObject.purpose !== session.purpose || mediaObject.visibility !== "private") {
      throw new Error("Finance receipt media cannot expose an invalid object");
    }
    return {
      mediaObjectId: mediaObject.mediaId,
      purpose: mediaObject.purpose,
      lifecycleStatus: mediaObject.lifecycleStatus,
      retainedUntil: mediaObject.retainedUntil ?? null,
    };
  }
  if (!isCanonicalHotelMediaSession(session)) return mediaObject;
  if (isAutoApprovedPublicMediaPurpose(session.purpose)) {
    return {
      mediaObjectId: mediaObject.mediaId,
      purpose: mediaObject.purpose as PropertyMediaLibraryItem["purpose"],
      status: "public_ready",
      publicVariants: mediaObject.variants
        .filter(
          (variant) =>
            PROPERTY_MEDIA_PUBLIC_VARIANTS.includes(variant.variantName as never) &&
            variant.publicCdnUrl,
        )
        .map((variant) => ({
          variantName:
            variant.variantName as PropertyMediaLibraryItem["publicVariants"][number]["variantName"],
          publicUrl: variant.publicCdnUrl!,
        })),
    };
  }
  if (!isCanonicalPrivatePropertyMediaObject({ mediaObject, mediaPathPrefix })) {
    throw new Error("Property media cannot be exposed before safe variants are persisted");
  }
  return {
    mediaObjectId: mediaObject.mediaId,
    purpose: mediaObject.purpose as PropertyMediaLibraryItem["purpose"],
    status: "private_ready",
    publicVariants: [],
  };
}

// prettier-ignore
type FinanceReceiptMediaItem = { mediaObjectId: string; purpose: "finance.expense.receipt"; lifecycleStatus: "staged" | "active"; retainedUntil: string | null };

function reusableCompletedMediaObjects(
  session: PlatformMediaSessionRecord,
  mediaPathPrefix: string,
): PlatformMediaObjectRecord[] | null {
  const mediaObjects =
    session.completedMediaObjects ??
    (session.completedMediaObject ? [session.completedMediaObject] : []);
  if (mediaObjects.length !== session.files.length) return null;
  if (!isCanonicalHotelMediaSession(session)) return mediaObjects;

  const expectedMediaIds = new Set(session.files.map(({ mediaId }) => mediaId));
  for (const mediaObject of mediaObjects) {
    if (
      !expectedMediaIds.delete(mediaObject.mediaId) ||
      mediaObject.purpose !== session.purpose ||
      !(isAutoApprovedPublicMediaPurpose(session.purpose)
        ? mediaObject.visibility === "public" &&
          mediaObject.approvalStatus === "approved" &&
          mediaObject.lifecycleStatus === "active"
        : isCanonicalPrivatePropertyMediaObject({ mediaObject, mediaPathPrefix }))
    ) {
      return null;
    }
  }
  return expectedMediaIds.size === 0 ? mediaObjects : null;
}

async function findCompletedFinalizeReplay(input: {
  repository: PlatformMediaRepository;
  session: PlatformMediaSessionRecord;
}): Promise<PlatformMediaSessionRecord | null> {
  const current = await input.repository.findUploadSessionForActor({
    sessionId: input.session.sessionId,
    actorUserId: input.session.actorUserId,
    ownerOrganizationId: input.session.ownerOrganizationId,
  });
  return current?.status === "completed" ? current : null;
}

function sendCompletedFinalizeReplay(
  reply: FastifyReply,
  session: PlatformMediaSessionRecord,
  mediaPathPrefix: string,
): FastifyReply {
  const mediaObjects = reusableCompletedMediaObjects(session, mediaPathPrefix);
  if (!mediaObjects) return sendNonReusableUploadSession(reply);
  setPrivateMediaResponseHeaders(reply, session);
  return reply.code(200).send({
    contractVersion: uploadContractVersion(session),
    uploadSession: serializeSession(session),
    mediaObject: serializeMediaObject(session, mediaObjects[0]!, mediaPathPrefix),
    mediaObjects: mediaObjects.map((mediaObject) =>
      serializeMediaObject(session, mediaObject, mediaPathPrefix),
    ),
    sideEffects: ["idempotency_replay"],
  });
}

function serializeImportJob(importJob: PlatformMediaImportJobRecord): Record<string, unknown> {
  return {
    importJobId: importJob.importJobId,
    jobKey: importJob.jobKey,
    purpose: importJob.purpose,
    status: importJob.status,
    resource: importJob.resource,
    target: importJob.target,
    sourceImageCount: importJob.sourceImageUrls.length,
    createdAt: importJob.createdAt,
  };
}

function isPropertyMediaPurpose(
  purpose: PlatformMediaPurpose,
): purpose is (typeof PROPERTY_MEDIA_UPLOAD_PURPOSES)[number] {
  return PROPERTY_MEDIA_UPLOAD_PURPOSES.includes(
    purpose as (typeof PROPERTY_MEDIA_UPLOAD_PURPOSES)[number],
  );
}

function isCanonicalHotelMediaSession(
  session: Pick<PlatformMediaSessionRecord, "purpose" | "resource">,
): boolean {
  return (
    isPropertyMediaPurpose(session.purpose) &&
    session.resource.product === PROPERTY_MEDIA_AUTHORIZATION.product &&
    session.resource.resourceType === PROPERTY_MEDIA_AUTHORIZATION.resourceType
  );
}

function uploadContractVersion(
  session: Pick<PlatformMediaSessionRecord, "purpose" | "resource">,
):
  | typeof PLATFORM_MEDIA_UPLOAD_CONTRACT_VERSION
  | typeof CANONICAL_HOTEL_MEDIA_UPLOAD_CONTRACT_VERSION {
  return isCanonicalHotelMediaSession(session)
    ? CANONICAL_HOTEL_MEDIA_UPLOAD_CONTRACT_VERSION
    : PLATFORM_MEDIA_UPLOAD_CONTRACT_VERSION;
}

function serializeAudit(context: RequestContext): Record<string, string> {
  return {
    requestId: context.audit.requestId,
    actorInternalUserId: context.actor.internalUserId,
    organizationId: context.selectedOrganization.organizationId,
  };
}

function sendMediaError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({ code, message });
}

function sendNonReusableUploadSession(reply: FastifyReply) {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Origin, Authorization");
  return sendMediaError(
    reply,
    409,
    "upload_session_not_reusable",
    "This upload session no longer matches the current media policy. Create a new session.",
  );
}

function sendPurposeUnavailable(reply: FastifyReply) {
  return sendMediaError(
    reply,
    503,
    "media_purpose_unavailable",
    "This media purpose is not available in the configured runtime.",
  );
}

function isPurposeEnabled(
  options: PlatformMediaRoutesOptions,
  purpose: PlatformMediaPurpose,
): boolean {
  return options.enabledPurposes?.includes(purpose) === true;
}

async function cleanupUploadedFiles(input: {
  finalizer: PlatformMediaUploadFinalizer;
  session: PlatformMediaSessionRecord;
  files: PlatformMediaFinalizedFileRecord[];
  timeoutMs: number;
  onError(error: unknown, file: PlatformMediaFinalizedFileRecord): void;
}): Promise<void> {
  if (!input.finalizer.cleanupUploadedFile) return;

  await Promise.all(
    input.files.map(async (file) => {
      try {
        await withTimeout(
          input.finalizer.cleanupUploadedFile!({ session: input.session, file }),
          input.timeoutMs,
        );
      } catch (error) {
        input.onError(error, file);
      }
    }),
  );
}

function finalizedFilesFromCompletedSession(
  session: PlatformMediaSessionRecord,
): PlatformMediaFinalizedFileRecord[] {
  const mediaObjects = new Map(
    (
      session.completedMediaObjects ??
      (session.completedMediaObject ? [session.completedMediaObject] : [])
    ).map((mediaObject) => [mediaObject.mediaId, mediaObject]),
  );
  return session.files.flatMap((sessionFile) => {
    const uploadTarget = session.uploadTargets.find(
      (candidate) => candidate.uploadTargetId === sessionFile.uploadTargetId,
    );
    const mediaObject = mediaObjects.get(sessionFile.mediaId);
    if (!uploadTarget || !mediaObject) return [];
    return [
      {
        sessionFile,
        uploadTarget,
        inspection: {
          contentType: mediaObject.contentType,
          sizeBytes: mediaObject.sizeBytes,
          checksumSha256: mediaObject.checksumSha256,
          widthPx: mediaObject.widthPx,
          heightPx: mediaObject.heightPx,
        },
      },
    ];
  });
}

function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  return Promise.race([
    operation,
    delay(timeoutMs, undefined, { ref: false }).then(() => {
      throw new Error(`Platform media staging cleanup timed out after ${timeoutMs} ms.`);
    }),
  ]);
}

function isMediaPurpose(value: unknown): value is PlatformMediaPurpose {
  return typeof value === "string" && Object.hasOwn(targetPurposePolicies, value);
}

function normalizeContentType(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeFilename(value: string): string {
  return value.trim().replaceAll("/", "_").replaceAll("\\", "_");
}

function filenameExtension(value: string): string | null {
  const filename = value.trim().toLowerCase();
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex > -1 ? filename.slice(dotIndex) : null;
}

function contentTypeAllowsExtension(contentType: string, extension: string): boolean {
  switch (contentType) {
    case "image/jpeg":
      return extension === ".jpg" || extension === ".jpeg";
    case "image/png":
      return extension === ".png";
    case "image/webp":
      return extension === ".webp";
    case "image/gif":
      return extension === ".gif";
    case "image/svg+xml":
      return extension === ".svg";
    case "image/heic":
      return extension === ".heic";
    case "image/heif":
      return extension === ".heif";
    case "application/pdf":
      return extension === ".pdf";
    default:
      return false;
  }
}

function isImageContentType(contentType: string): boolean {
  return normalizeContentType(contentType).startsWith("image/");
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isSupportedSourceImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const extension = filenameExtension(url.pathname);
    if (extension === null) return true;
    return targetPurposePolicies["pms.import.source_image"].allowedExtensions.includes(extension);
  } catch {
    return false;
  }
}

function resizedVariantDimensions(
  variantName: PlatformMediaVariantName,
  widthPx: number | undefined,
  heightPx: number | undefined,
): { widthPx: number; heightPx: number } | null {
  if (!widthPx || !heightPx || variantName === "provider_original") {
    return widthPx && heightPx ? { widthPx, heightPx } : null;
  }
  const max = PROPERTY_MEDIA_PUBLIC_VARIANT_MAX_DIMENSIONS[variantName];
  const scale = Math.min(1, max.widthPx / widthPx, max.heightPx / heightPx);
  return {
    widthPx: Math.max(1, Math.round(widthPx * scale)),
    heightPx: Math.max(1, Math.round(heightPx * scale)),
  };
}

function resizedVariantSize(
  inspection: PlatformMediaFinalizedFileInspection,
  dimensions: { widthPx: number; heightPx: number } | null,
): number {
  if (!dimensions || !inspection.widthPx || !inspection.heightPx) return inspection.sizeBytes;
  const originalPixels = inspection.widthPx * inspection.heightPx;
  const variantPixels = dimensions.widthPx * dimensions.heightPx;
  return Math.max(1, Math.round(inspection.sizeBytes * (variantPixels / originalPixels)));
}

function sourceFilename(sourceImageUrl: string, index: number): string {
  try {
    const pathname = new URL(sourceImageUrl).pathname;
    const filename = pathname.split("/").filter(Boolean).pop();
    return filename ? normalizeFilename(filename) : `source-${index + 1}.jpg`;
  } catch {
    return `source-${index + 1}.jpg`;
  }
}
