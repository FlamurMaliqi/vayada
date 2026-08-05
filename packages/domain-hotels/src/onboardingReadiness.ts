import { PROPERTY_SETUP_STEP_DEFINITIONS, type PropertySetupStepId } from "./propertySetupDraft.js";

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
  owningStepId: PropertySetupStepId;
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
  owningStepId: PropertySetupStepId;
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

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ProductReadinessResult = DeepReadonly<ProductReadinessEvaluation> & {
  readonly outcome: "evaluated";
  readonly sourceManifestHash: SourceManifestHash;
  readonly readinessHash: ProductReadinessHash;
};

/** Typed product-level failure when readiness cannot be evaluated at all. */
export type ReadinessProviderFailure = {
  readonly outcome: "provider_failure";
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

const PROPERTY_SETUP_STEP_IDS = new Set(
  PROPERTY_SETUP_STEP_DEFINITIONS.map(({ stepId }) => stepId),
);
const READINESS_PRODUCT_IDS = new Set<string>(READINESS_PRODUCTS);
const READINESS_SOURCE_DOMAIN_IDS = new Set<string>(READINESS_SOURCE_DOMAINS);
const READINESS_STATUS_IDS = new Set<string>(READINESS_STATUSES);
const READINESS_BLOCKER_KIND_IDS = new Set<string>(READINESS_BLOCKER_KINDS);
const READINESS_ERROR_SOURCE_IDS = new Set<string>(READINESS_ERROR_SOURCES);

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
  return deepFreeze({
    ...snapshot,
    outcome: "evaluated" as const,
    sourceManifestHash,
    readinessHash,
  });
}

function assertReadinessIntegrity(evaluation: ProductReadinessEvaluation): void {
  if (evaluation.contractVersion !== PRODUCT_READINESS_CONTRACT_VERSION) {
    throw new Error("Readiness uses an unsupported contract version");
  }
  assertNonEmptyString(evaluation.propertyId, "readiness property ID");
  assertNonEmptyString(evaluation.evaluatedAt, "readiness evaluation timestamp");
  assertAllowedValue(evaluation.product, READINESS_PRODUCT_IDS, "readiness product");
  assertAllowedValue(evaluation.status, READINESS_STATUS_IDS, "product readiness status");
  if (evaluation.propertyId !== evaluation.sourceManifest.propertyId) {
    throw new Error("Readiness and source manifest must identify the same property");
  }
  const manifestSources = assertUniqueManifestSources(evaluation.sourceManifest);
  if (evaluation.groups.length === 0) {
    if (evaluation.status === "error") {
      throw new Error("Product errors require a structured blocker or provider failure");
    }
    throw new Error("Product readiness requires at least one group");
  }
  const allowedGroupIds: readonly string[] = READINESS_GROUP_IDS_BY_PRODUCT[evaluation.product];
  const groupIds = new Set<ReadinessGroupId>();
  let hasStructuredError = false;
  for (const group of evaluation.groups) {
    if (!allowedGroupIds.includes(group.groupId)) {
      throw new Error("Readiness group does not belong to its product");
    }
    if (groupIds.has(group.groupId)) {
      throw new Error("Readiness contains a duplicate group");
    }
    groupIds.add(group.groupId);
    assertAllowedValue(group.status, READINESS_STATUS_IDS, "group readiness status");
    if (group.steps.length === 0) {
      throw new Error("Readiness groups require at least one step");
    }
    const stepIds = new Set<PropertySetupStepId>();
    for (const step of group.steps) {
      if (!PROPERTY_SETUP_STEP_IDS.has(step.owningStepId)) {
        throw new Error("Readiness step does not identify a property setup route step");
      }
      if (stepIds.has(step.owningStepId)) {
        throw new Error("Readiness group contains a duplicate step");
      }
      stepIds.add(step.owningStepId);
      assertAllowedValue(step.status, READINESS_STATUS_IDS, "step readiness status");
      if (step.entities.length === 0) {
        throw new Error("Readiness steps require at least one entity");
      }
      const entityIds = new Set<string>();
      for (const entity of step.entities) {
        assertSourceEntityRevision(entity.source, "readiness entity source");
        const identity = sourceIdentity(entity.source);
        if (entityIds.has(identity)) {
          throw new Error("Readiness step contains a duplicate entity");
        }
        entityIds.add(identity);
        assertAllowedValue(entity.status, READINESS_STATUS_IDS, "entity readiness status");
        if (manifestSources.get(identity) !== entity.source.revision) {
          throw new Error("Readiness entity source is absent or stale in its manifest");
        }
        for (const blocker of entity.blockers) {
          assertReadinessBlocker(blocker);
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
        assertStatusRollup(
          entity.status,
          rollupReadinessStatuses(entity.blockers.map(readinessStatusForBlocker)),
          "entity",
        );
      }
      assertStatusRollup(
        step.status,
        rollupReadinessStatuses(step.entities.map(({ status }) => status)),
        "step",
      );
    }
    assertStatusRollup(
      group.status,
      rollupReadinessStatuses(group.steps.map(({ status }) => status)),
      "group",
    );
  }
  if (evaluation.status === "error" && !hasStructuredError) {
    throw new Error("Product errors require a structured blocker or provider failure");
  }
  assertStatusRollup(
    evaluation.status,
    rollupReadinessStatuses(evaluation.groups.map(({ status }) => status)),
    "product",
  );
}

function assertUniqueManifestSources(manifest: SourceManifest): Map<string, SourceRevisionValue> {
  if (manifest.contractVersion !== SOURCE_MANIFEST_CONTRACT_VERSION) {
    throw new Error("Source manifest uses an unsupported contract version");
  }
  assertNonEmptyString(manifest.propertyId, "source manifest property ID");
  const sources = new Map<string, SourceRevisionValue>();
  for (const source of manifest.sources) {
    assertSourceEntityRevision(source, "source manifest entity");
    const identity = sourceIdentity(source);
    if (sources.has(identity)) throw new Error("Source manifest contains a duplicate entity");
    sources.set(identity, source.revision);
  }
  return sources;
}

function assertReadinessBlocker(blocker: ReadinessBlocker): void {
  assertAllowedValue(blocker.kind, READINESS_BLOCKER_KIND_IDS, "readiness blocker kind");
  assertNonEmptyString(blocker.code, "readiness blocker code");
  assertNonEmptyString(blocker.message, "readiness blocker message");
  assertSourceEntityRevision(blocker.source, "readiness blocker source");
  if (blocker.kind === "system_error") {
    assertAllowedValue(
      blocker.errorSource,
      READINESS_ERROR_SOURCE_IDS,
      "readiness blocker error source",
    );
  } else if ("errorSource" in blocker && blocker.errorSource !== undefined) {
    throw new Error("Only system-error blockers may identify an error source");
  }
}

function assertSourceEntityRevision(source: SourceEntityRevision, label: string): void {
  assertAllowedValue(source.ownerDomain, READINESS_SOURCE_DOMAIN_IDS, `${label} owner domain`);
  assertNonEmptyString(source.entityType, `${label} entity type`);
  assertNonEmptyString(source.entityId, `${label} entity ID`);
  assertNonEmptyString(source.revision, `${label} revision`);
}

function readinessStatusForBlocker(blocker: ReadinessBlocker): ReadinessStatus {
  switch (blocker.kind) {
    case "user_fixable":
      return "blocked";
    case "external_pending":
      return "pending";
    case "system_error":
      return "error";
  }
}

function rollupReadinessStatuses(statuses: readonly ReadinessStatus[]): ReadinessStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("pending")) return "pending";
  return "ready";
}

function assertStatusRollup(
  actual: ReadinessStatus,
  expected: ReadinessStatus,
  scope: "entity" | "step" | "group" | "product",
): void {
  if (actual !== expected) {
    throw new Error(`Readiness ${scope} status does not match its child results`);
  }
}

function assertAllowedValue(value: string, allowed: ReadonlySet<string>, label: string): void {
  if (!allowed.has(value)) throw new Error(`Unsupported ${label}`);
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}`);
  }
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
    // Contract arrays are unordered sets. Ordered arrays require a new canonicalization contract.
    return `[${value.map(canonicalJson).sort().join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  Object.freeze(object);
  return value;
}

async function sha256(value: string): Promise<`sha256:${string}`> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sha256:${hex}`;
}
