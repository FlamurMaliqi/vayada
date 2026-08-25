import type { StaffRemovalJobRepository } from "./staffRemovalJobs.js";

export type StaffRemovalProviderMembership = {
  id: string;
  organizationId: string;
  userId: string;
};

export interface StaffRemovalProvider {
  getMembership(id: string): Promise<StaffRemovalProviderMembership | null>;
  deleteMembership(id: string): Promise<"deleted" | "already_absent">;
}

export function createStaffRemovalCoordinator(input: {
  repository: StaffRemovalJobRepository;
  provider: StaffRemovalProvider;
}) {
  return {
    async revoke(jobId: string) {
      const claim = await input.repository.claim(jobId);
      if (claim.outcome === "succeeded") return { outcome: "revoked" as const, jobId };
      if (claim.outcome === "dead_lettered") {
        return { outcome: "reconciliation_required" as const, jobId };
      }
      if (claim.outcome !== "claimed") return { outcome: "not_ready" as const, jobId };

      const binding = providerBinding(claim.payload);
      if (!binding) {
        return (await input.repository.markDeadLettered(
          jobId,
          claim.leaseToken,
          "provider_binding_missing",
        ))
          ? { outcome: "reconciliation_required" as const, jobId }
          : { outcome: "not_ready" as const, jobId };
      }

      try {
        const membership = await input.provider.getMembership(binding.workosMembershipId);
        if (!membership) {
          return (await input.repository.markSucceeded(jobId, claim.leaseToken, "already_absent"))
            ? { outcome: "revoked" as const, jobId }
            : { outcome: "not_ready" as const, jobId };
        }
        if (
          membership.id !== binding.workosMembershipId ||
          membership.organizationId !== binding.expectedWorkosOrganizationId ||
          membership.userId !== binding.expectedWorkosUserId
        ) {
          return (await input.repository.markDeadLettered(
            jobId,
            claim.leaseToken,
            "provider_binding_mismatch",
          ))
            ? { outcome: "reconciliation_required" as const, jobId }
            : { outcome: "not_ready" as const, jobId };
        }
        const providerOutcome = await input.provider.deleteMembership(binding.workosMembershipId);
        return (await input.repository.markSucceeded(jobId, claim.leaseToken, providerOutcome))
          ? { outcome: "revoked" as const, jobId }
          : { outcome: "not_ready" as const, jobId };
      } catch {
        const status = await input.repository.markRetryableFailure(jobId, claim.leaseToken);
        return {
          outcome: status === "dead_lettered" ? ("reconciliation_required" as const) : status,
          jobId,
        };
      }
    },
  };
}

function providerBinding(payload: unknown): {
  workosMembershipId: string;
  expectedWorkosOrganizationId: string;
  expectedWorkosUserId: string;
} | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  const workosMembershipId = nonEmptyString(value["workosMembershipId"]);
  const expectedWorkosOrganizationId = nonEmptyString(value["expectedWorkosOrganizationId"]);
  const expectedWorkosUserId = nonEmptyString(value["expectedWorkosUserId"]);
  return workosMembershipId && expectedWorkosOrganizationId && expectedWorkosUserId
    ? { workosMembershipId, expectedWorkosOrganizationId, expectedWorkosUserId }
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
