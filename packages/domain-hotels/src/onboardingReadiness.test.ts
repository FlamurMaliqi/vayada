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

type HashFixture = {
  contractVersion: string;
  manifest: SourceManifest;
  evaluation: Omit<ProductReadinessEvaluation, "sourceManifest">;
  expected: Record<"sourceManifestHash" | "readinessHash", `sha256:${string}`>;
};

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../engineering/fixtures/onboarding-readiness-contract/hash-case.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as HashFixture;

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

    expect(original.sourceManifestHash).toBe(fixture.expected.sourceManifestHash);
    expect(original.readinessHash).toBe(fixture.expected.readinessHash);
    expect(replay).toMatchObject({
      sourceManifestHash: original.sourceManifestHash,
      readinessHash: original.readinessHash,
    });
  });

  it("keeps nested readiness contribution order out of hash identity", async () => {
    const evaluation = fixtureEvaluation();
    const buildGroup = (groupId: ReadinessGroupId): ReadinessGroupResult => ({
      groupId,
      status: "blocked",
      steps: ["primary", "secondary"].map((suffix) => {
        const owningStepId = `${groupId}.${suffix}`;
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
    });
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
  });
});
