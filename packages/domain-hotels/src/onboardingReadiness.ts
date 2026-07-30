export const SOURCE_MANIFEST_CONTRACT_VERSION = "onboarding-source-manifest.v1" as const;
export const PRODUCT_READINESS_CONTRACT_VERSION = "onboarding-product-readiness.v1" as const;

export const READINESS_PRODUCTS = ["marketplace", "booking"] as const;
export type ReadinessProduct = (typeof READINESS_PRODUCTS)[number];

export const READINESS_GROUP_IDS_BY_PRODUCT = {
  marketplace: ["marketplace.hotel_profile", "marketplace.collaboration_preferences"],
  booking: [
    "booking.hotel_profile",
    "booking.page_style",
    "booking.rooms",
    "booking.pricing",
    "booking.calendar",
    "booking.guest_experience",
    "booking.payments",
  ],
} as const satisfies Record<ReadinessProduct, readonly string[]>;

export const READINESS_SOURCE_DOMAINS = [
  "hotel_catalog",
  "marketplace",
  "booking",
  "pms",
  "finance",
] as const;
export const READINESS_STATUSES = ["ready", "blocked", "pending", "error"] as const;
export const READINESS_BLOCKER_KINDS = [
  "user_fixable",
  "external_pending",
  "system_error",
] as const;
export const READINESS_ERROR_SOURCES = ["provider", "system"] as const;

export type ReadinessGroupId = (typeof READINESS_GROUP_IDS_BY_PRODUCT)[ReadinessProduct][number];
export type ReadinessSourceDomain = (typeof READINESS_SOURCE_DOMAINS)[number];
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];
export type ReadinessBlockerKind = (typeof READINESS_BLOCKER_KINDS)[number];
export type ReadinessErrorSource = (typeof READINESS_ERROR_SOURCES)[number];
export type SourceRevisionValue = string;
export type SourceManifestHash = `sha256:${string}`;
export type ProductReadinessHash = `sha256:${string}`;

/** Owner-defined opaque identity and immutable revision. */
export type SourceEntityRevision = {
  ownerDomain: ReadinessSourceDomain;
  entityType: string;
  entityId: string;
  revision: SourceRevisionValue;
};

export type SourceManifest = {
  contractVersion: typeof SOURCE_MANIFEST_CONTRACT_VERSION;
  propertyId: string;
  sources: readonly SourceEntityRevision[];
};

/** Portable coordinates let consumers route a blocker without owner-table access. */
type ReadinessBlockerBase = {
  code: string;
  message: string;
  product: ReadinessProduct;
  groupId: ReadinessGroupId;
  owningStepId: string;
  source: SourceEntityRevision;
};

export type ReadinessBlocker =
  | (ReadinessBlockerBase & {
      kind: "user_fixable";
      errorSource?: never;
    })
  | (ReadinessBlockerBase & {
      kind: "external_pending";
      errorSource?: never;
    })
  | (ReadinessBlockerBase & {
      kind: "system_error";
      errorSource: ReadinessErrorSource;
    });

export type ReadinessEntityResult = {
  source: SourceEntityRevision;
  status: ReadinessStatus;
  blockers: readonly ReadinessBlocker[];
};

export type ReadinessStepResult = {
  /** Opaque here; the adaptive route validates it against its own step model. */
  owningStepId: string;
  status: ReadinessStatus;
  entities: readonly ReadinessEntityResult[];
};

export type ReadinessGroupResult = {
  groupId: ReadinessGroupId;
  status: ReadinessStatus;
  steps: readonly ReadinessStepResult[];
};

export type ProductReadinessEvaluation = {
  contractVersion: typeof PRODUCT_READINESS_CONTRACT_VERSION;
  propertyId: string;
  product: ReadinessProduct;
  status: ReadinessStatus;
  sourceManifest: SourceManifest;
  groups: readonly ReadinessGroupResult[];
  /** Excluded from readiness identity. */
  evaluatedAt: string;
};

export type ProductReadinessResult = ProductReadinessEvaluation & {
  sourceManifestHash: SourceManifestHash;
  readinessHash: ProductReadinessHash;
};

/** Typed product-level failure when readiness cannot be evaluated at all. */
export type ReadinessProviderFailure = {
  contractVersion: typeof PRODUCT_READINESS_CONTRACT_VERSION;
  propertyId: string;
  product: ReadinessProduct;
  status: "error";
  error: {
    kind: "system_error";
    errorSource: ReadinessErrorSource;
    code: string;
    message: string;
    retryable: true;
  };
  evaluatedAt: string;
};

export type ProductReadinessRequest = {
  propertyId: string;
  product: ReadinessProduct;
};

/** Cross-domain consumers use this port rather than opening product tables. */
export interface ReadinessProviderPort {
  getProductReadiness(
    request: ProductReadinessRequest,
  ): Promise<ProductReadinessResult | ReadinessProviderFailure>;
}

export async function hashSourceManifest(manifest: SourceManifest): Promise<SourceManifestHash> {
  const snapshot = structuredClone(manifest);
  assertUniqueManifestSources(snapshot);
  return sha256(canonicalJson(snapshot));
}

/** Snapshots mutable input and attaches both order-independent contract hashes. */
export async function createProductReadinessResult(
  evaluation: ProductReadinessEvaluation,
): Promise<ProductReadinessResult> {
  const snapshot = structuredClone(evaluation);
  assertReadinessIntegrity(snapshot);
  const sourceManifestHash = await sha256(canonicalJson(snapshot.sourceManifest));
  const readinessHash = await sha256(
    canonicalJson({
      contractVersion: snapshot.contractVersion,
      propertyId: snapshot.propertyId,
      product: snapshot.product,
      status: snapshot.status,
      sourceManifestHash,
      groups: snapshot.groups,
    }),
  );
  return {
    ...snapshot,
    sourceManifestHash,
    readinessHash,
  };
}

function assertReadinessIntegrity(evaluation: ProductReadinessEvaluation): void {
  if (evaluation.propertyId !== evaluation.sourceManifest.propertyId) {
    throw new Error("Readiness and source manifest must identify the same property");
  }
  const manifestSources = assertUniqueManifestSources(evaluation.sourceManifest);
  const allowedGroupIds: readonly string[] = READINESS_GROUP_IDS_BY_PRODUCT[evaluation.product];
  let hasStructuredError = false;
  for (const group of evaluation.groups) {
    if (!allowedGroupIds.includes(group.groupId)) {
      throw new Error("Readiness group does not belong to its product");
    }
    for (const step of group.steps) {
      for (const entity of step.entities) {
        const identity = sourceIdentity(entity.source);
        if (manifestSources.get(identity) !== entity.source.revision) {
          throw new Error("Readiness entity source is absent or stale in its manifest");
        }
        for (const blocker of entity.blockers) {
          if (blocker.kind === "system_error") hasStructuredError = true;
          if (
            blocker.product !== evaluation.product ||
            blocker.groupId !== group.groupId ||
            blocker.owningStepId !== step.owningStepId ||
            sourceIdentity(blocker.source) !== identity ||
            blocker.source.revision !== entity.source.revision
          ) {
            throw new Error("Readiness blocker coordinates do not match their entity");
          }
        }
      }
    }
  }
  if (evaluation.status === "error" && !hasStructuredError) {
    throw new Error("Product errors require a structured blocker or provider failure");
  }
}

function assertUniqueManifestSources(manifest: SourceManifest): Map<string, SourceRevisionValue> {
  const sources = new Map<string, SourceRevisionValue>();
  for (const source of manifest.sources) {
    const identity = sourceIdentity(source);
    if (sources.has(identity)) throw new Error("Source manifest contains a duplicate entity");
    sources.set(identity, source.revision);
  }
  return sources;
}

function sourceIdentity(source: SourceEntityRevision): string {
  return JSON.stringify([source.ownerDomain, source.entityType, source.entityId]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).sort().join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

async function sha256(value: string): Promise<`sha256:${string}`> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sha256:${hex}`;
}
