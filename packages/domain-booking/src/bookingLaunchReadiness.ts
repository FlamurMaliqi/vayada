import {
  PRODUCT_READINESS_CONTRACT_VERSION,
  SOURCE_MANIFEST_CONTRACT_VERSION,
  createProductReadinessResult,
  hashSourceManifest,
  type ProductReadinessResult,
  type ReadinessBlocker,
  type ReadinessErrorSource,
  type ReadinessProviderFailure,
  type ReadinessStatus,
  type SourceEntityRevision,
} from "@vayada/domain-hotels";
import {
  BOOKING_LAUNCH_DERIVED_BINDING_SOURCE_ENTITY_TYPE,
  BOOKING_LAUNCH_READINESS_GROUPS,
  bookingLaunchSourceKey,
  isBookingLaunchOwnerEvidenceValid,
  isBookingLaunchOwnerUnavailable,
  isBookingLaunchReadinessRequestValid,
  sanitizeBookingLaunchSource,
  type BookingLaunchCatalogEvidencePort,
  type BookingLaunchConfigurationEvidencePort,
  type BookingLaunchFinanceEvidencePort,
  type BookingLaunchOwnerBlocker,
  type BookingLaunchOwnerEvidence,
  type BookingLaunchPmsEvidencePort,
  type BookingLaunchReadinessPortKey,
  type BookingLaunchReadinessProviderPort,
} from "./bookingLaunchEvidence.js";

export function createBookingLaunchReadinessProvider(config: {
  catalog: BookingLaunchCatalogEvidencePort;
  booking: BookingLaunchConfigurationEvidencePort;
  pms: BookingLaunchPmsEvidencePort;
  finance: BookingLaunchFinanceEvidencePort;
  now?: () => Date;
}): BookingLaunchReadinessProviderPort {
  const ports = {
    catalog: config.catalog,
    booking: config.booking,
    pms: config.pms,
    finance: config.finance,
  } as const;
  const now = config.now ?? (() => new Date());

  return {
    async getBookingReadiness(request) {
      let failurePropertyId = "";
      try {
        if (!isBookingLaunchReadinessRequestValid(request)) {
          return providerFailure(
            failurePropertyId,
            "provider",
            "booking_readiness_request_invalid",
            now,
          );
        }
        const requestSnapshot = Object.freeze({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
        });
        failurePropertyId = requestSnapshot.propertyId;
        const ownerRequest = () => Object.freeze({ ...requestSnapshot });

        let results: readonly unknown[];
        try {
          results = await Promise.all([
            ports.catalog.getBookingLaunchEvidence(ownerRequest()),
            ports.booking.getBookingLaunchEvidence(ownerRequest()),
            ports.pms.getBookingLaunchEvidence(ownerRequest()),
            ports.finance.getBookingLaunchEvidence(ownerRequest()),
          ]);
        } catch {
          return providerFailure(
            failurePropertyId,
            "system",
            "booking_readiness_owner_unavailable",
            now,
          );
        }

        const evidenceByPort = new Map<BookingLaunchReadinessPortKey, BookingLaunchOwnerEvidence>();
        for (const [index, portKey] of (
          ["catalog", "booking", "pms", "finance"] as const
        ).entries()) {
          const result = results[index];
          if (isBookingLaunchOwnerUnavailable(result, portKey)) {
            return providerFailure(
              failurePropertyId,
              result.errorSource,
              "booking_readiness_owner_unavailable",
              now,
            );
          }
          if (!isBookingLaunchOwnerEvidenceValid(result, requestSnapshot, portKey)) {
            return providerFailure(
              failurePropertyId,
              "provider",
              "booking_readiness_evidence_invalid",
              now,
            );
          }
          evidenceByPort.set(portKey, result);
        }

        return await composeReadiness(failurePropertyId, evidenceByPort, now);
      } catch {
        return providerFailure(
          failurePropertyId,
          "provider",
          "booking_readiness_evidence_invalid",
          now,
        );
      }
    },
  };
}

async function composeReadiness(
  propertyId: string,
  evidenceByPort: ReadonlyMap<BookingLaunchReadinessPortKey, BookingLaunchOwnerEvidence>,
  now: () => Date,
): Promise<ProductReadinessResult> {
  const manifestSources = new Map<string, SourceEntityRevision>();
  for (const evidence of evidenceByPort.values()) {
    for (const source of evidence.sources) {
      const sanitized = sanitizeBookingLaunchSource(source);
      const key = bookingLaunchSourceKey(sanitized);
      const existing = manifestSources.get(key);
      if (existing && existing.revision !== sanitized.revision) {
        throw new Error("Owner evidence contains conflicting source revisions");
      }
      manifestSources.set(key, sanitized);
    }
  }
  await addBindingSetSources(propertyId, evidenceByPort, manifestSources);

  const groups = BOOKING_LAUNCH_READINESS_GROUPS.map((spec) => {
    const evidence = evidenceByPort.get(spec.port);
    const contributions =
      evidence?.entities.filter(({ groupId }) => groupId === spec.groupId) ?? [];
    if (contributions.length === 0) throw new Error("Owner evidence omitted a required group");
    const entities = contributions
      .map((contribution) => {
        const source = sanitizeBookingLaunchSource(contribution.source);
        if (
          contribution.owningStepId !== spec.owningStepId ||
          source.ownerDomain !== spec.entityOwnerDomain ||
          !manifestSources.has(bookingLaunchSourceKey(source))
        ) {
          throw new Error("Owner evidence has invalid group coordinates");
        }
        const mismatchBlockers = (contribution.bindings ?? [])
          .filter(({ expectedSource }) => {
            const current = manifestSources.get(bookingLaunchSourceKey(expectedSource));
            return !current || current.revision !== expectedSource.revision;
          })
          .map(({ mismatchBlocker }) => mismatchBlocker);
        const blockers = [...contribution.blockers, ...mismatchBlockers]
          .map((blocker) =>
            toReadinessBlocker(blocker, {
              groupId: spec.groupId,
              owningStepId: spec.owningStepId,
              source,
            }),
          )
          .sort(compareBlockers);
        return {
          source,
          status: statusForBlockers(blockers),
          blockers,
        };
      })
      .sort((left, right) =>
        bookingLaunchSourceKey(left.source).localeCompare(bookingLaunchSourceKey(right.source)),
      );
    const stepStatus = rollup(entities.map(({ status }) => status));
    return {
      groupId: spec.groupId,
      status: stepStatus,
      steps: [
        {
          owningStepId: spec.owningStepId,
          status: stepStatus,
          entities,
        },
      ],
    };
  });

  return createProductReadinessResult({
    contractVersion: PRODUCT_READINESS_CONTRACT_VERSION,
    propertyId,
    product: "booking",
    status: rollup(groups.map(({ status }) => status)),
    sourceManifest: {
      contractVersion: SOURCE_MANIFEST_CONTRACT_VERSION,
      propertyId,
      sources: [...manifestSources.values()].sort((left, right) =>
        bookingLaunchSourceKey(left).localeCompare(bookingLaunchSourceKey(right)),
      ),
    },
    groups,
    evaluatedAt: now().toISOString(),
  });
}

async function addBindingSetSources(
  propertyId: string,
  evidenceByPort: ReadonlyMap<BookingLaunchReadinessPortKey, BookingLaunchOwnerEvidence>,
  manifestSources: Map<string, SourceEntityRevision>,
): Promise<void> {
  for (const evidence of evidenceByPort.values()) {
    for (const contribution of evidence.entities) {
      const bindingSources = (contribution.bindings ?? [])
        .map(({ expectedSource }) => sanitizeBookingLaunchSource(expectedSource))
        .sort((left, right) =>
          bookingLaunchSourceKey(left).localeCompare(bookingLaunchSourceKey(right)),
        );
      if (bindingSources.length === 0) continue;
      const source = sanitizeBookingLaunchSource(contribution.source);
      // This Booking-owned derived revision makes the dependency graph part of command identity.
      const bindingSetSource: SourceEntityRevision = {
        ownerDomain: "booking",
        entityType: BOOKING_LAUNCH_DERIVED_BINDING_SOURCE_ENTITY_TYPE,
        entityId: JSON.stringify([
          contribution.groupId,
          source.ownerDomain,
          source.entityType,
          source.entityId,
        ]),
        revision: await hashSourceManifest({
          contractVersion: SOURCE_MANIFEST_CONTRACT_VERSION,
          propertyId,
          sources: bindingSources,
        }),
      };
      const key = bookingLaunchSourceKey(bindingSetSource);
      if (manifestSources.has(key))
        throw new Error("Owner evidence contains duplicate binding sets");
      manifestSources.set(key, bindingSetSource);
    }
  }
}

function statusForBlockers(blockers: readonly ReadinessBlocker[]): ReadinessStatus {
  return rollup(
    blockers.map(({ kind }) =>
      kind === "system_error" ? "error" : kind === "user_fixable" ? "blocked" : "pending",
    ),
  );
}

function toReadinessBlocker(
  blocker: BookingLaunchOwnerBlocker,
  coordinates: Pick<ReadinessBlocker, "groupId" | "owningStepId" | "source">,
): ReadinessBlocker {
  const base = {
    code: blocker.code,
    message: safeMessageFor(blocker.kind),
    product: "booking" as const,
    groupId: coordinates.groupId,
    owningStepId: coordinates.owningStepId,
    source: sanitizeBookingLaunchSource(coordinates.source),
  };
  return blocker.kind === "system_error"
    ? { ...base, kind: blocker.kind, errorSource: blocker.errorSource }
    : { ...base, kind: blocker.kind };
}

function rollup(statuses: readonly ReadinessStatus[]): ReadinessStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("pending")) return "pending";
  return "ready";
}

function compareBlockers(left: ReadinessBlocker, right: ReadinessBlocker): number {
  return JSON.stringify([
    left.kind,
    left.errorSource ?? null,
    left.code,
    left.message,
  ]).localeCompare(
    JSON.stringify([right.kind, right.errorSource ?? null, right.code, right.message]),
  );
}

function safeMessageFor(kind: BookingLaunchOwnerBlocker["kind"]): string {
  switch (kind) {
    case "user_fixable":
      return "Review this setup step before publishing.";
    case "external_pending":
      return "This setup step is still being processed.";
    case "system_error":
      return "This setup step is temporarily unavailable.";
  }
}

function providerFailure(
  propertyId: string,
  errorSource: ReadinessErrorSource,
  code: string,
  now: () => Date,
): ReadinessProviderFailure {
  return Object.freeze({
    outcome: "provider_failure",
    contractVersion: PRODUCT_READINESS_CONTRACT_VERSION,
    propertyId,
    product: "booking",
    status: "error",
    error: Object.freeze({
      kind: "system_error",
      errorSource,
      code,
      message: "Booking launch readiness is temporarily unavailable.",
      retryable: true,
    }),
    evaluatedAt: now().toISOString(),
  });
}
