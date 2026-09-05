import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_MATCHING_CONTRACT_VERSION,
  MARKETPLACE_MATCHING_ELIGIBILITY_RULE_CODES,
  MARKETPLACE_MATCHING_EVENT_FORBIDDEN_FIELDS,
  MARKETPLACE_MATCHING_EVENT_TYPES,
  MARKETPLACE_MATCHING_IMPRESSION_DEDUPLICATION_MS,
  buildMarketplaceMatchingImpressionId,
  parseMarketplaceMatchingEvent,
  reduceLatestMarketplaceMatchingGuardrails,
  reduceLatestMarketplaceMatchingSatisfaction,
  type MarketplaceMatchGuardrailRecordedEvent,
  type MarketplaceMatchSatisfactionRecordedEvent,
} from "./index.js";

const ids = {
  event: "00000000-0000-4000-8000-000000000001",
  creator: "00000000-0000-4000-8000-000000000002",
  offer: "00000000-0000-4000-8000-000000000003",
  evaluation: "00000000-0000-4000-8000-000000000004",
  collaboration: "00000000-0000-4000-8000-000000000005",
  subject: "00000000-0000-4000-8000-000000000006",
} as const;

const occurredAt = "2026-09-03T00:00:00.000Z";
const policyVersion = "matching-policy.v1";
const impressionId = buildMarketplaceMatchingImpressionId({
  policyVersion,
  creatorProfileId: ids.creator,
  offerId: ids.offer,
  occurredAt,
});
const base = {
  eventId: ids.event,
  occurredAt,
  creatorProfileId: ids.creator,
  offerId: ids.offer,
  contractVersion: MARKETPLACE_MATCHING_CONTRACT_VERSION,
  correlationId: "correlation-1",
} as const;
const recommended = {
  kind: "recommended",
  policyVersion,
  evaluationId: ids.evaluation,
  impressionId,
  recommendationSessionId: "session-1",
  surface: "creator_offer_discovery",
  presentationMode: "ranked",
} as const;
const organic = {
  kind: "organic",
  policyVersion: null,
  evaluationId: null,
  impressionId: null,
  recommendationSessionId: null,
  surface: null,
  presentationMode: null,
} as const;
const ruleResults = MARKETPLACE_MATCHING_ELIGIBILITY_RULE_CODES.map((ruleCode) => ({
  ruleCode,
  outcome: "pass" as const,
}));

const validEvents = [
  {
    ...base,
    eventType: "marketplace.match.evaluated.v1",
    policyVersion,
    evaluationId: ids.evaluation,
    revision: 1,
    evaluationMode: "active",
    eligibilityStatus: "eligible",
    eligibilityRuleResults: ruleResults,
    hotelFitBps: 8_000,
    creatorFitBps: 7_000,
    pairFitBps: 7_000,
    hotelCoverageBps: 10_000,
    creatorCoverageBps: 9_000,
    confidence: "high",
    reasonCodes: ["destination_match", "platform_match"],
    evidenceCounts: { known: 8, unknown: 1, stale: 0, unavailable: 0, notApplicable: 0 },
  },
  {
    ...base,
    eventType: "marketplace.match.impression.v1",
    policyVersion,
    evaluationId: ids.evaluation,
    revision: 1,
    impressionId,
    recommendationSessionId: "session-1",
    surface: "creator_offer_discovery",
    presentationMode: "ranked",
    rank: 1,
    slot: 1,
  },
  {
    ...base,
    eventType: "marketplace.match.saved.v1",
    attribution: recommended,
    saveId: ids.subject,
    revision: 1,
  },
  {
    ...base,
    eventType: "marketplace.match.dismissed.v1",
    attribution: recommended,
    dismissalId: ids.subject,
    revision: 1,
    reasonCode: "not_interested",
  },
  {
    ...base,
    eventType: "marketplace.match.application_submitted.v1",
    attribution: recommended,
    collaborationId: ids.collaboration,
    revision: 1,
  },
  {
    ...base,
    eventType: "marketplace.match.invitation_sent.v1",
    attribution: organic,
    collaborationId: ids.collaboration,
    revision: 1,
  },
  {
    ...base,
    eventType: "marketplace.match.response_recorded.v1",
    attribution: recommended,
    collaborationId: ids.collaboration,
    revision: 2,
    respondentSide: "hotel",
    response: "positive",
  },
  {
    ...base,
    eventType: "marketplace.match.accepted.v1",
    attribution: recommended,
    collaborationId: ids.collaboration,
    revision: 3,
  },
  {
    ...base,
    eventType: "marketplace.match.completed.v1",
    attribution: recommended,
    collaborationId: ids.collaboration,
    revision: 4,
  },
  {
    ...base,
    eventType: "marketplace.match.rating_recorded.v1",
    attribution: recommended,
    ratingId: ids.subject,
    collaborationId: ids.collaboration,
    revision: 1,
    respondentSide: "creator",
    subjectSide: "hotel",
    score: 5,
  },
  {
    ...base,
    eventType: "marketplace.match.satisfaction_recorded.v1",
    attribution: recommended,
    feedbackId: ids.subject,
    collaborationId: ids.collaboration,
    revision: 1,
    respondentSide: "creator",
    outcome: "satisfied",
  },
  {
    ...base,
    eventType: "marketplace.match.guardrail_recorded.v1",
    attribution: recommended,
    guardrailId: ids.subject,
    collaborationId: ids.collaboration,
    revision: 1,
    state: "opened",
    code: "dispute",
  },
] as const;

describe("Marketplace matching events", () => {
  it("exports and parses every approved versioned event", () => {
    expect(validEvents.map((event) => event.eventType)).toEqual(MARKETPLACE_MATCHING_EVENT_TYPES);
    for (const event of validEvents) expect(parseMarketplaceMatchingEvent(event)).toEqual(event);
  });

  it("uses a deterministic, canonical 24-hour impression identity", () => {
    expect(MARKETPLACE_MATCHING_IMPRESSION_DEDUPLICATION_MS).toBe(86_400_000);
    expect(impressionId).toBe("02d7cb4166a8c79e73568abe44b4f625f6961ecd9a95eed158ba62536115582f");
    expect(
      buildMarketplaceMatchingImpressionId({
        policyVersion,
        creatorProfileId: ids.creator.toUpperCase(),
        offerId: ids.offer.toUpperCase(),
        occurredAt: "2026-09-03T23:59:59.999Z",
      }),
    ).toBe(impressionId);
    expect(
      buildMarketplaceMatchingImpressionId({
        policyVersion,
        creatorProfileId: ids.creator,
        offerId: ids.offer,
        occurredAt: "2026-09-04T00:00:00.000Z",
      }),
    ).not.toBe(impressionId);
  });

  it("rejects unknown fields at every safe payload boundary", () => {
    const evaluated = validEvents[0];
    const saved = validEvents[2];
    for (const field of MARKETPLACE_MATCHING_EVENT_FORBIDDEN_FIELDS) {
      expect(parseMarketplaceMatchingEvent({ ...saved, [field]: "private" })).toBeNull();
    }
    expect(
      parseMarketplaceMatchingEvent({
        ...saved,
        attribution: { ...recommended, contactData: "private@example.com" },
      }),
    ).toBeNull();
    expect(
      parseMarketplaceMatchingEvent({
        ...evaluated,
        evidenceCounts: { ...evaluated.evidenceCounts, providerPayload: {} },
      }),
    ).toBeNull();
    expect(
      parseMarketplaceMatchingEvent({
        ...evaluated,
        eligibilityRuleResults: [
          { ...evaluated.eligibilityRuleResults[0], profileText: "private" },
          ...evaluated.eligibilityRuleResults.slice(1),
        ],
      }),
    ).toBeNull();
  });

  it("keeps organic and recommended attribution mutually exclusive", () => {
    const saved = validEvents[2];
    const invitation = validEvents[5];
    expect(parseMarketplaceMatchingEvent({ ...saved, attribution: organic })).not.toBeNull();
    expect(
      parseMarketplaceMatchingEvent({
        ...saved,
        attribution: { ...organic, impressionId },
      }),
    ).toBeNull();
    expect(
      parseMarketplaceMatchingEvent({
        ...saved,
        attribution: { ...recommended, impressionId: null },
      }),
    ).toBeNull();
    expect(parseMarketplaceMatchingEvent({ ...invitation, attribution: recommended })).toBeNull();
  });

  it("enforces evaluation and event-specific invariants", () => {
    const evaluated = validEvents[0];
    const impression = validEvents[1];
    const dismissed = validEvents[3];
    const rating = validEvents[9];
    expect(parseMarketplaceMatchingEvent({ ...evaluated, pairFitBps: 8_000 })).toBeNull();
    expect(parseMarketplaceMatchingEvent({ ...evaluated, confidence: "insufficient" })).toBeNull();
    expect(
      parseMarketplaceMatchingEvent({
        ...evaluated,
        hotelFitBps: null,
        pairFitBps: null,
        hotelCoverageBps: 1,
        confidence: "insufficient",
      }),
    ).toBeNull();
    expect(
      parseMarketplaceMatchingEvent({
        ...evaluated,
        eligibilityStatus: "ineligible",
        hotelFitBps: null,
        creatorFitBps: null,
        pairFitBps: null,
        confidence: "insufficient",
        eligibilityRuleResults: ruleResults.map((result, index) =>
          index === 0 ? { ...result, outcome: "conflict" } : result,
        ),
      }),
    ).not.toBeNull();
    expect(
      parseMarketplaceMatchingEvent({
        ...evaluated,
        eligibilityStatus: "ineligible",
        hotelFitBps: null,
        creatorFitBps: null,
        pairFitBps: null,
        confidence: "high",
        eligibilityRuleResults: ruleResults.map((result, index) =>
          index === 0 ? { ...result, outcome: "conflict" } : result,
        ),
      }),
    ).toBeNull();
    expect(
      parseMarketplaceMatchingEvent({ ...impression, impressionId: "0".repeat(64) }),
    ).toBeNull();
    expect(parseMarketplaceMatchingEvent({ ...dismissed, reasonCode: "not_relevant" })).toBeNull();
    expect(parseMarketplaceMatchingEvent({ ...rating, subjectSide: "creator" })).toBeNull();
    expect(parseMarketplaceMatchingEvent({ ...rating, score: 6 })).toBeNull();
  });
});

describe("Marketplace matching revision reducers", () => {
  const satisfaction = validEvents[10] as MarketplaceMatchSatisfactionRecordedEvent;
  const guardrail = validEvents[11] as MarketplaceMatchGuardrailRecordedEvent;

  it("selects the latest satisfaction revision per collaboration and respondent", () => {
    const creatorRevisionTwo = { ...satisfaction, revision: 2, outcome: "neutral" } as const;
    const hotel = { ...satisfaction, respondentSide: "hotel", outcome: "dissatisfied" } as const;
    expect(
      reduceLatestMarketplaceMatchingSatisfaction([creatorRevisionTwo, hotel, satisfaction]),
    ).toEqual({
      ok: true,
      latest: [creatorRevisionTwo, hotel],
    });
  });

  it("selects the latest guardrail revision per collaboration and guardrail", () => {
    const resolved = {
      ...guardrail,
      collaborationId: guardrail.collaborationId.toUpperCase(),
      guardrailId: guardrail.guardrailId.toUpperCase(),
      revision: 2,
      state: "resolved",
    } as const;
    expect(reduceLatestMarketplaceMatchingGuardrails([resolved, guardrail])).toEqual({
      ok: true,
      latest: [resolved],
    });
  });

  it("rejects duplicate revisions even when separated by a newer revision", () => {
    expect(
      reduceLatestMarketplaceMatchingSatisfaction([
        satisfaction,
        { ...satisfaction, revision: 2 },
        {
          ...satisfaction,
          eventId: ids.subject,
          collaborationId: satisfaction.collaborationId.toUpperCase(),
        },
      ]),
    ).toEqual({
      ok: false,
      code: "duplicate_revision",
      subjectKey: `${ids.collaboration}:creator`,
      revision: 1,
    });
  });
});
