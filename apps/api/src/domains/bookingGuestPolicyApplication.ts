import {
  BOOKING_GUEST_POLICY_CONTRACT_VERSION,
  BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES,
  composeBookingGuestPolicy,
  createBookingGuestPolicyNewDraft,
  evaluateBookingGuestPolicyReadiness,
  parseBookingGuestPolicyChoices,
  parseBookingGuestPolicyCatalogProfileEvidenceResult,
  parseBookingGuestPolicyCurrentOwnerEvidenceScope,
  parseBookingGuestPolicyRevision,
  serializeBookingGuestPolicyCommandFingerprint,
  type BookingGuestPolicyApplicationPort,
  type BookingGuestPolicyAuthorizedReplayPort,
  type BookingGuestPolicyCatalogProfileEvidenceResult,
  type BookingGuestPolicyChoices,
  type BookingGuestPolicyComposition,
  type BookingGuestPolicyCurrentOwnerEvidencePort,
  type BookingGuestPolicyOwnerEvidencePorts,
  type BookingGuestPolicyPersistencePort,
  type BookingGuestPolicyReadPort,
  type BookingGuestPolicyRevision,
  type BookingGuestPolicySetupAggregate,
} from "@vayada/domain-booking";

export type BookingGuestPolicyApplicationDependencies = Readonly<{
  authorizedReplay: BookingGuestPolicyAuthorizedReplayPort;
  persistence: BookingGuestPolicyPersistencePort;
  read: Pick<BookingGuestPolicyReadPort, "getCurrentGuestPolicy">;
  ownerEvidence: BookingGuestPolicyOwnerEvidencePorts;
  currentOwnerEvidence: BookingGuestPolicyCurrentOwnerEvidencePort;
}>;

export function createBookingGuestPolicyApplication(
  dependencies: BookingGuestPolicyApplicationDependencies,
): BookingGuestPolicyApplicationPort {
  return {
    async upsertGuestPolicy(command) {
      serializeBookingGuestPolicyCommandFingerprint(command);
      const scope = requireScope(command);
      const replay = await dependencies.authorizedReplay.findAuthorizedReplay(command);
      if (replay.outcome === "replay") {
        const revision = requireCurrentRevision(replay.revision, scope);
        return Object.freeze({ ok: true, outcome: "idempotent_replay", revision });
      }
      if (replay.outcome === "rejected") {
        return Object.freeze({ ok: false, error: replay.error });
      }
      if (replay.outcome !== "not_found") {
        throw new TypeError("Booking guest-policy authorized replay result is malformed");
      }

      const composition = await composeFromOwners(
        dependencies.ownerEvidence,
        scope,
        command.choices,
      );
      if (composition.outcome === "blocked") {
        return Object.freeze({
          ok: false,
          error: Object.freeze({ code: "guest_policy_not_ready", blockers: composition.blockers }),
        });
      }
      if (composition.bundle.sourceFingerprint !== command.expectedSourceFingerprint) {
        return Object.freeze({
          ok: false,
          error: Object.freeze({
            code: "source_revision_conflict",
            currentSourceFingerprint: composition.bundle.sourceFingerprint,
          }),
        });
      }
      return dependencies.persistence.persistGuestPolicy({
        ...command,
        bundle: composition.bundle,
      });
    },

    async previewGuestPolicy(input) {
      const scope = requireScope(input);
      const choices = parseBookingGuestPolicyChoices(input.choices);
      if (!choices) throw new TypeError("Booking guest-policy preview choices are malformed");
      return composeFromOwners(dependencies.ownerEvidence, scope, choices);
    },

    async getGuestPolicySetup(input) {
      const scope = requireScope(input);
      const current = await readCurrent(dependencies.read, scope);
      if (!current) return newSetupAggregate(scope);
      const composition = await composeFromOwners(
        dependencies.ownerEvidence,
        scope,
        current.bundle.choices,
      );
      return deepFreeze({
        contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
        organizationId: scope.organizationId,
        propertyId: scope.propertyId,
        supportedLanguages: BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES,
        draft: null,
        current,
        composition,
      });
    },

    async getGuestPolicyReadiness(input) {
      const scope = requireScope(input);
      const current = await readCurrent(dependencies.read, scope);
      const [composition, currentOwnerEvidence] = await Promise.all([
        current
          ? composeFromOwners(dependencies.ownerEvidence, scope, current.bundle.choices)
          : Promise.resolve(null),
        dependencies.currentOwnerEvidence.getCurrentGuestPolicyOwnerEvidence(scope),
      ]);
      return evaluateBookingGuestPolicyReadiness({
        ...scope,
        current,
        composition,
        currentOwnerEvidence,
      });
    },
  };
}

async function composeFromOwners(
  ports: BookingGuestPolicyOwnerEvidencePorts,
  scope: Readonly<{ organizationId: string; propertyId: string }>,
  choices: BookingGuestPolicyChoices,
): Promise<BookingGuestPolicyComposition> {
  const [catalogResult, roomResult, pricingResult, recurringResult, confirmationResult] =
    await Promise.allSettled([
      ports.catalogProfile.getCatalogProfileEvidence(scope),
      ports.rooms.getRoomPublicationSnapshot(scope),
      ports.pricing.getPricingSourceSnapshot(scope.propertyId),
      ports.recurringPricing.getRecurringPricingBookingEvidence(scope.propertyId),
      ports.mandatoryChargeConfirmation.getMandatoryChargeConfirmation(scope),
    ]);
  const catalogProfile: BookingGuestPolicyCatalogProfileEvidenceResult =
    catalogResult.status === "fulfilled"
      ? (parseBookingGuestPolicyCatalogProfileEvidenceResult(
          catalogResult.value,
          scope.propertyId,
        ) ?? Object.freeze({ outcome: "malformed" }))
      : Object.freeze({ outcome: "unavailable", errorSource: "system" });
  const pricing =
    roomResult.status === "fulfilled" &&
    pricingResult.status === "fulfilled" &&
    recurringResult.status === "fulfilled" &&
    pricingResult.value !== null &&
    recurringResult.value !== null
      ? {
          roomPublication: roomResult.value,
          pricing: pricingResult.value,
          recurringPricing: recurringResult.value,
        }
      : null;
  const mandatoryChargeConfirmation =
    confirmationResult.status === "fulfilled"
      ? confirmationResult.value
      : Object.freeze({ outcome: "unavailable", errorSource: "system" });
  try {
    return composeBookingGuestPolicy({
      request: scope,
      choices,
      catalogProfile,
      pricing,
      mandatoryChargeConfirmation,
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const fallback = composeBookingGuestPolicy({
      request: scope,
      choices,
      catalogProfile,
      pricing: null,
      mandatoryChargeConfirmation,
    });
    if (fallback.outcome !== "blocked")
      throw new TypeError("Booking guest-policy owner evidence is malformed");
    return deepFreeze({
      ...fallback,
      blockers: fallback.blockers.map((candidate) =>
        candidate.code === "pricing_source_missing"
          ? Object.freeze({ code: "pricing_source_invalid" as const })
          : candidate,
      ),
    });
  }
}

async function readCurrent(
  read: Pick<BookingGuestPolicyReadPort, "getCurrentGuestPolicy">,
  scope: Readonly<{ organizationId: string; propertyId: string }>,
): Promise<BookingGuestPolicyRevision | null> {
  const value = await read.getCurrentGuestPolicy(scope);
  return value === null ? null : requireCurrentRevision(value, scope);
}

function requireCurrentRevision(
  value: unknown,
  scope: Readonly<{ organizationId: string; propertyId: string }>,
): BookingGuestPolicyRevision {
  const revision = parseBookingGuestPolicyRevision(value);
  if (
    !revision ||
    revision.organizationId !== scope.organizationId ||
    revision.propertyId !== scope.propertyId
  )
    throw new TypeError("Booking guest-policy revision is malformed or outside request scope");
  return revision;
}

function newSetupAggregate(
  scope: Readonly<{ organizationId: string; propertyId: string }>,
): BookingGuestPolicySetupAggregate {
  return deepFreeze({
    contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    organizationId: scope.organizationId,
    propertyId: scope.propertyId,
    supportedLanguages: BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES,
    draft: createBookingGuestPolicyNewDraft(),
    current: null,
    composition: null,
  });
}

function requireScope(value: {
  organizationId: unknown;
  propertyId: unknown;
}): Readonly<{ organizationId: string; propertyId: string }> {
  const scope = parseBookingGuestPolicyCurrentOwnerEvidenceScope({
    organizationId: value.organizationId,
    propertyId: value.propertyId,
  });
  if (!scope) throw new TypeError("Booking guest-policy application scope is malformed");
  return scope;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
