import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  PRODUCT_READINESS_CONTRACT_VERSION,
  READINESS_BLOCKER_KINDS,
  READINESS_ERROR_SOURCES,
  createProductReadinessResult,
  type ProductReadinessEvaluation,
  type ReadinessGroupId,
  type ReadinessGroupResult,
  type ReadinessProviderFailure,
  type SourceManifest,
} from "./onboardingReadiness.js";
import type { PropertySetupStepId } from "./propertySetupDraft.js";

type HashFixture = {
  contractVersion: string;
  manifest: SourceManifest;
  evaluation: Omit<ProductReadinessEvaluation, "sourceManifest">;
  expected: Record<"sourceManifestHash" | "readinessHash", `sha256:${string}`>;
};

// The fixture remains repository-shared so other runtimes can verify the same hash vectors.
const HASH_FIXTURE_URL = new URL(
  "../../../engineering/fixtures/onboarding-readiness-contract/hash-case.json",
  import.meta.url,
);
const fixture = JSON.parse(readHashFixture()) as HashFixture;

function readHashFixture(): string {
  try {
    return readFileSync(HASH_FIXTURE_URL, "utf8");
  } catch (error) {
    throw new Error(`Required shared readiness hash fixture is unavailable: ${String(error)}`);
  }
}

function fixtureEvaluation(): ProductReadinessEvaluation {
  return structuredClone({
    ...fixture.evaluation,
    sourceManifest: fixture.manifest,
  });
}

describe("onboarding source manifest and readiness contract", () => {
  it("matches the hash fixture across source order and observation time", async () => {
    expect(fixture.contractVersion).toBe("onboarding-readiness-hash-fixture.v1");

    const reordered = fixtureEvaluation();
    reordered.sourceManifest = {
      ...reordered.sourceManifest,
      sources: [...reordered.sourceManifest.sources].reverse(),
    };
    reordered.evaluatedAt = "2026-07-30T17:45:00.000Z";

    const [original, replay] = await Promise.all([
      createProductReadinessResult(fixtureEvaluation()),
      createProductReadinessResult(reordered),
    ]);

    expect(original.outcome).toBe("evaluated");
    expect(original.sourceManifestHash).toBe(fixture.expected.sourceManifestHash);
    expect(original.readinessHash).toBe(fixture.expected.readinessHash);
    expect(replay).toMatchObject({
      sourceManifestHash: original.sourceManifestHash,
      readinessHash: original.readinessHash,
    });
  });

  it("keeps nested readiness contribution order out of hash identity", async () => {
    const evaluation = fixtureEvaluation();
    const buildGroup = (groupId: ReadinessGroupId): ReadinessGroupResult => {
      const owningStepIds: PropertySetupStepId[] =
        groupId === "booking.payments" ? ["payments", "review"] : ["present_hotel", "review"];
      return {
        groupId,
        status: "blocked",
        steps: owningStepIds.map((owningStepId) => {
          return {
            owningStepId,
            status: "blocked",
            entities: evaluation.sourceManifest.sources.map((source, sourceIndex) => ({
              source,
              status: "blocked",
              blockers: ["missing", "stale"].map((code) => ({
                kind: "user_fixable",
                code: `${groupId}.${sourceIndex}.${code}`,
                message: "Complete the required setup.",
                product: "booking",
                groupId,
                owningStepId,
                source,
              })),
            })),
          };
        }),
      };
    };
    evaluation.groups = [buildGroup("booking.hotel_profile"), buildGroup("booking.payments")];
    const reversed = structuredClone(evaluation);
    reversed.sourceManifest = {
      ...reversed.sourceManifest,
      sources: [...reversed.sourceManifest.sources].reverse(),
    };
    reversed.groups = [...reversed.groups].reverse().map((group) => ({
      ...group,
      steps: [...group.steps].reverse().map((step) => ({
        ...step,
        entities: [...step.entities].reverse().map((entity) => ({
          ...entity,
          blockers: [...entity.blockers].reverse(),
        })),
      })),
    }));

    const [ordered, reordered] = await Promise.all([
      createProductReadinessResult(evaluation),
      createProductReadinessResult(reversed),
    ]);
    expect(reordered.sourceManifestHash).toBe(ordered.sourceManifestHash);
    expect(reordered.readinessHash).toBe(ordered.readinessHash);
  });

  it("changes both identities when an owning source revision changes", async () => {
    const changed = JSON.parse(
      JSON.stringify(fixtureEvaluation()).replaceAll("payment-settings:4", "payment-settings:5"),
    ) as ProductReadinessEvaluation;

    const [original, next] = await Promise.all([
      createProductReadinessResult(fixtureEvaluation()),
      createProductReadinessResult(changed),
    ]);

    expect(next.sourceManifestHash).not.toBe(original.sourceManifestHash);
    expect(next.readinessHash).not.toBe(original.readinessHash);
  });

  it("keeps owner omissions, waits, provider failures, and system failures distinct", () => {
    const providerFailure = {
      outcome: "provider_failure",
      contractVersion: PRODUCT_READINESS_CONTRACT_VERSION,
      propertyId: fixture.evaluation.propertyId,
      product: "booking",
      status: "error",
      error: {
        kind: "system_error",
        errorSource: "provider",
        code: "readiness_unavailable",
        message: "Readiness could not be evaluated.",
        retryable: true,
      },
      evaluatedAt: fixture.evaluation.evaluatedAt,
    } satisfies ReadinessProviderFailure;

    expect(READINESS_BLOCKER_KINDS).toEqual(["user_fixable", "external_pending", "system_error"]);
    expect(READINESS_ERROR_SOURCES).toEqual(["provider", "system"]);
    expect(providerFailure.error).toMatchObject({ errorSource: "provider", retryable: true });
  });

  it("rolls each blocker kind into the product status", async () => {
    for (const { kind, status, errorSource } of [
      { kind: "user_fixable", status: "blocked", errorSource: undefined },
      { kind: "external_pending", status: "pending", errorSource: undefined },
      { kind: "system_error", status: "error", errorSource: "system" },
    ] as const) {
      const evaluation = fixtureEvaluation();
      const group = evaluation.groups[0]!;
      const step = group.steps[0]!;
      const entity = step.entities[0]!;
      const blocker = entity.blockers[0]! as unknown as {
        kind: string;
        errorSource?: string;
      };
      blocker.kind = kind;
      if (errorSource === undefined) delete blocker.errorSource;
      else blocker.errorSource = errorSource;
      evaluation.status = status;
      group.status = status;
      step.status = status;
      entity.status = status;

      const result = await createProductReadinessResult(evaluation);
      expect(result).toMatchObject({
        outcome: "evaluated",
        status,
        groups: [{ status, steps: [{ status, entities: [{ status }] }] }],
      });
    }
  });

  it("rejects unsupported runtime contract and enum values", async () => {
    const wrongReadinessVersion = fixtureEvaluation();
    (wrongReadinessVersion as { contractVersion: string }).contractVersion =
      "onboarding-product-readiness.v2";
    await expect(createProductReadinessResult(wrongReadinessVersion)).rejects.toThrow(
      /readiness uses an unsupported contract version/i,
    );

    const wrongManifestVersion = fixtureEvaluation();
    (wrongManifestVersion.sourceManifest as { contractVersion: string }).contractVersion =
      "onboarding-source-manifest.v2";
    await expect(createProductReadinessResult(wrongManifestVersion)).rejects.toThrow(
      /manifest uses an unsupported contract version/i,
    );

    const unknownProduct = fixtureEvaluation();
    (unknownProduct as { product: string }).product = "pms";
    await expect(createProductReadinessResult(unknownProduct)).rejects.toThrow("readiness product");

    const unknownDomain = fixtureEvaluation();
    (unknownDomain.sourceManifest.sources[0]! as { ownerDomain: string }).ownerDomain = "sales";
    await expect(createProductReadinessResult(unknownDomain)).rejects.toThrow("owner domain");

    const invalidPropertyId = fixtureEvaluation();
    (invalidPropertyId as unknown as { propertyId: unknown }).propertyId = null;
    (invalidPropertyId.sourceManifest as unknown as { propertyId: unknown }).propertyId = null;
    await expect(createProductReadinessResult(invalidPropertyId)).rejects.toThrow("property ID");

    for (const [field, value, message] of [
      ["entityType", "", "entity type"],
      ["entityId", null, "entity ID"],
      ["revision", 7, "revision"],
    ] as const) {
      const invalidSource = fixtureEvaluation();
      (invalidSource.sourceManifest.sources[0]! as unknown as Record<string, unknown>)[field] =
        value;
      await expect(createProductReadinessResult(invalidSource)).rejects.toThrow(message);
    }

    const unknownStatus = fixtureEvaluation();
    (unknownStatus.groups[0]! as { status: string }).status = "complete";
    await expect(createProductReadinessResult(unknownStatus)).rejects.toThrow(
      "group readiness status",
    );

    const unknownKind = fixtureEvaluation();
    (
      unknownKind.groups[0]!.steps[0]!.entities[0]!.blockers[0]! as unknown as {
        kind: string;
      }
    ).kind = "warning";
    await expect(createProductReadinessResult(unknownKind)).rejects.toThrow("blocker kind");

    const unknownErrorSource = fixtureEvaluation();
    const errorBlocker = unknownErrorSource.groups[0]!.steps[0]!.entities[0]!
      .blockers[0]! as unknown as { kind: string; errorSource: string };
    errorBlocker.kind = "system_error";
    errorBlocker.errorSource = "database";
    await expect(createProductReadinessResult(unknownErrorSource)).rejects.toThrow("error source");

    const forbiddenErrorSource = fixtureEvaluation();
    const userFixableBlocker = forbiddenErrorSource.groups[0]!.steps[0]!.entities[0]!
      .blockers[0]! as unknown as { errorSource?: string };
    userFixableBlocker.errorSource = "provider";
    await expect(createProductReadinessResult(forbiddenErrorSource)).rejects.toThrow(
      "Only system-error blockers",
    );

    const explicitUndefined = fixtureEvaluation();
    const optionalErrorSource = explicitUndefined.groups[0]!.steps[0]!.entities[0]!
      .blockers[0]! as unknown as { errorSource?: string };
    optionalErrorSource.errorSource = undefined;
    await expect(createProductReadinessResult(explicitUndefined)).resolves.toMatchObject({
      outcome: "evaluated",
      readinessHash: fixture.expected.readinessHash,
    });
  });

  it("rejects status rollups that disagree with their child results", async () => {
    const wrongEntity = fixtureEvaluation();
    wrongEntity.groups[0]!.steps[0]!.entities[0]!.status = "ready";
    await expect(createProductReadinessResult(wrongEntity)).rejects.toThrow(
      "entity status does not match",
    );

    const wrongStep = fixtureEvaluation();
    wrongStep.groups[0]!.steps[0]!.status = "ready";
    await expect(createProductReadinessResult(wrongStep)).rejects.toThrow(
      "step status does not match",
    );

    const wrongGroup = fixtureEvaluation();
    wrongGroup.groups[0]!.status = "ready";
    await expect(createProductReadinessResult(wrongGroup)).rejects.toThrow(
      "group status does not match",
    );

    const wrongProduct = fixtureEvaluation();
    wrongProduct.status = "ready";
    await expect(createProductReadinessResult(wrongProduct)).rejects.toThrow(
      "product status does not match",
    );

    const blockerlessBlockedEntity = fixtureEvaluation();
    blockerlessBlockedEntity.groups[0]!.steps[0]!.entities[0]!.blockers = [];
    await expect(createProductReadinessResult(blockerlessBlockedEntity)).rejects.toThrow(
      "entity status does not match",
    );
  });

  it("rejects duplicate readiness graph nodes", async () => {
    const duplicateGroup = fixtureEvaluation();
    duplicateGroup.groups = [...duplicateGroup.groups, structuredClone(duplicateGroup.groups[0]!)];
    await expect(createProductReadinessResult(duplicateGroup)).rejects.toThrow("duplicate group");

    const duplicateStep = fixtureEvaluation();
    duplicateStep.groups[0]!.steps = [
      ...duplicateStep.groups[0]!.steps,
      structuredClone(duplicateStep.groups[0]!.steps[0]!),
    ];
    await expect(createProductReadinessResult(duplicateStep)).rejects.toThrow("duplicate step");

    const duplicateEntity = fixtureEvaluation();
    duplicateEntity.groups[0]!.steps[0]!.entities = [
      ...duplicateEntity.groups[0]!.steps[0]!.entities,
      structuredClone(duplicateEntity.groups[0]!.steps[0]!.entities[0]!),
    ];
    await expect(createProductReadinessResult(duplicateEntity)).rejects.toThrow("duplicate entity");
  });

  it("rejects readiness claims without a non-empty evidence graph", async () => {
    const emptyProduct = fixtureEvaluation();
    emptyProduct.status = "ready";
    emptyProduct.groups = [];
    await expect(createProductReadinessResult(emptyProduct)).rejects.toThrow("at least one group");

    const emptyGroup = fixtureEvaluation();
    emptyGroup.groups[0]!.steps = [];
    await expect(createProductReadinessResult(emptyGroup)).rejects.toThrow("at least one step");

    const emptyStep = fixtureEvaluation();
    emptyStep.groups[0]!.steps[0]!.entities = [];
    await expect(createProductReadinessResult(emptyStep)).rejects.toThrow("at least one entity");
  });

  it("rejects contradictory graphs and snapshots mutable input before hashing", async () => {
    const stale = fixtureEvaluation();
    stale.groups[0]!.steps[0]!.entities[0]!.source.revision = "payment-settings:stale";
    await expect(createProductReadinessResult(stale)).rejects.toThrow("absent or stale");

    const misdirected = fixtureEvaluation();
    misdirected.groups[0]!.steps[0]!.entities[0]!.blockers[0]!.product = "marketplace";
    await expect(createProductReadinessResult(misdirected)).rejects.toThrow("coordinates");

    const duplicate = fixtureEvaluation();
    duplicate.sourceManifest = {
      ...duplicate.sourceManifest,
      sources: [...duplicate.sourceManifest.sources, duplicate.sourceManifest.sources[0]!],
    };
    await expect(createProductReadinessResult(duplicate)).rejects.toThrow("duplicate entity");

    const unknownStep = fixtureEvaluation();
    unknownStep.groups[0]!.steps[0]!.owningStepId = "choose_payments" as PropertySetupStepId;
    unknownStep.groups[0]!.steps[0]!.entities[0]!.blockers[0]!.owningStepId =
      "choose_payments" as PropertySetupStepId;
    await expect(createProductReadinessResult(unknownStep)).rejects.toThrow(
      "property setup route step",
    );

    const unstructuredError = { ...fixtureEvaluation(), status: "error", groups: [] } as const;
    await expect(createProductReadinessResult(unstructuredError)).rejects.toThrow(
      "structured blocker or provider failure",
    );

    const mutable = fixtureEvaluation();
    const pending = createProductReadinessResult(mutable);
    mutable.sourceManifest.sources[0]!.revision = "provider-account:mutated";
    const snapshot = await pending;
    expect(snapshot.sourceManifestHash).toBe(fixture.expected.sourceManifestHash);
    expect(snapshot.sourceManifest.sources[0]!.revision).not.toBe("provider-account:mutated");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sourceManifest.sources[0]!)).toBe(true);
    expect(() => {
      (snapshot.groups[0]! as unknown as { status: string }).status = "ready";
    }).toThrow(TypeError);
  });
});
