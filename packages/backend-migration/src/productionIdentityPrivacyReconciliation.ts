import type { IdentityMigrationBlocker } from "./productionIdentityDisposition.js";
import type {
  PlannedCookieConsent,
  PlannedUserConsent,
} from "./productionIdentityConsentSource.js";
import { isNewer, sortedBy } from "./productionIdentityOwnershipPolicy.js";
import type {
  PlannedConsentHistory,
  PlannedGdprRequest,
} from "./productionIdentityPrivacyRecordSource.js";
import {
  addBlocker,
  addDuplicateValueBlockers,
  date,
  optionalDate,
  stableJson,
} from "./productionIdentitySourceValidation.js";

export type ExistingCookieConsent = Omit<PlannedCookieConsent, "necessary"> & {
  necessary: boolean;
};
export type IdentityPrivacyReconciliationPlan = {
  userConsents: PlannedUserConsent[];
  cookieConsents: ExistingCookieConsent[];
  consentHistory: PlannedConsentHistory[];
  gdprRequests: PlannedGdprRequest[];
  blockers: IdentityMigrationBlocker[];
};
export type ExistingPrivacyState = {
  userConsents: PlannedUserConsent[];
  cookieConsents: ExistingCookieConsent[];
  consentHistory: PlannedConsentHistory[];
  gdprRequests: PlannedGdprRequest[];
};

export function reconcileIdentityPrivacy(
  source: Omit<IdentityPrivacyReconciliationPlan, "blockers">,
  existing: ExistingPrivacyState,
): IdentityPrivacyReconciliationPlan {
  const blockers: IdentityMigrationBlocker[] = [];
  const targetUsers = by(existing.userConsents.map(userConsent), (row) => row.userId);
  const userConsents = source.userConsents.flatMap((row) => {
    const normalized = userConsent(row);
    return choose(
      normalized,
      targetUsers.get(normalized.userId),
      "identity.user_consent_status",
      normalized.userId,
      userConsentState,
      blockers,
      (fresh, target) => ({ ...fresh, createdAt: target.createdAt }),
    );
  });

  const targetCookies = by(existing.cookieConsents.map(cookieConsent), (row) => row.visitorId);
  const cookieConsents = source.cookieConsents.flatMap((row) => {
    const normalized = cookieConsent(row);
    return choose(
      normalized,
      targetCookies.get(normalized.visitorId),
      "identity.cookie_consents",
      normalized.visitorId,
      cookieState,
      blockers,
      (fresh, target) => ({ ...fresh, id: target.id, createdAt: target.createdAt }),
    );
  });

  const targetHistory = by(existing.consentHistory.map(consentHistory), (row) => row.id);
  const consentHistoryRows = source.consentHistory.flatMap((row) => {
    const normalized = consentHistory(row);
    const target = targetHistory.get(normalized.id);
    if (!target) return [normalized];
    if (stableJson(target) === stableJson(normalized)) return [target];
    addBlocker(
      blockers,
      "CONSENT_HISTORY_TARGET_CONFLICT",
      "identity.consent_history",
      normalized.id,
      "Immutable source and target consent records disagree",
    );
    return [];
  });

  const targetGdpr = by(existing.gdprRequests.map(gdprRequest), (row) => row.id);
  const gdprRequests = source.gdprRequests.flatMap((row) => {
    const normalized = gdprRequest(row);
    const target = targetGdpr.get(normalized.id);
    if (target && gdprIdentity(target) !== gdprIdentity(normalized)) {
      addBlocker(
        blockers,
        "GDPR_TARGET_IDENTITY_CONFLICT",
        "identity.gdpr_requests",
        normalized.id,
        "Source and target immutable request identity disagrees",
      );
      return [];
    }
    return choose(
      normalized,
      target,
      "identity.gdpr_requests",
      normalized.id,
      gdprState,
      blockers,
      (fresh, current) => ({ ...fresh, createdAt: current.createdAt }),
    );
  });

  const finalCookies = new Map(targetCookies);
  for (const row of cookieConsents) finalCookies.set(row.visitorId, row);
  addDuplicateValueBlockers(
    [...finalCookies.values()],
    (row) => row.id,
    (row) => row.visitorId,
    "identity.cookie_consents",
    "COOKIE_TARGET_ID_CONFLICT",
    blockers,
  );
  const finalGdpr = new Map(targetGdpr);
  for (const row of gdprRequests) finalGdpr.set(row.id, row);
  addDuplicateValueBlockers(
    [...finalGdpr.values()].filter((row) => row.downloadToken !== null),
    (row) => row.downloadToken!,
    (row) => row.id,
    "identity.gdpr_requests",
    "GDPR_TARGET_TOKEN_CONFLICT",
    blockers,
    (_token, owners) => owners.join(","),
  );

  return {
    userConsents: sortedBy(userConsents, (row) => row.userId),
    cookieConsents: sortedBy(cookieConsents, (row) => row.visitorId),
    consentHistory: sortedBy(consentHistoryRows, (row) => row.id),
    gdprRequests: sortedBy(gdprRequests, (row) => row.id),
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
}

function choose<T extends { updatedAt: string }>(
  source: T,
  target: T | undefined,
  table: string,
  id: string,
  state: (row: T) => unknown,
  blockers: IdentityMigrationBlocker[],
  mergeSource: (source: T, target: T) => T,
): T[] {
  if (!target) return [source];
  if (isNewer(target, source)) return [target];
  if (isNewer(source, target)) return [mergeSource(source, target)];
  if (stableJson(state(target)) === stableJson(state(source))) return [target];
  addBlocker(
    blockers,
    "PRIVACY_EQUAL_TIME_CONFLICT",
    table,
    id,
    "Source and target privacy state disagrees at equal freshness",
  );
  return [];
}

const by = <T>(rows: T[], key: (row: T) => string) => new Map(rows.map((row) => [key(row), row]));
const record = (value: Record<string, unknown>) =>
  JSON.parse(stableJson(value)) as Record<string, never>;
const userConsent = (row: PlannedUserConsent): PlannedUserConsent => ({
  ...row,
  termsAcceptedAt: optionalDate(row.termsAcceptedAt, "termsAcceptedAt"),
  privacyAcceptedAt: optionalDate(row.privacyAcceptedAt, "privacyAcceptedAt"),
  marketingConsentAt: optionalDate(row.marketingConsentAt, "marketingConsentAt"),
  createdAt: date(row.createdAt, "createdAt"),
  updatedAt: date(row.updatedAt, "updatedAt"),
});
const cookieConsent = (row: ExistingCookieConsent): ExistingCookieConsent => ({
  ...row,
  createdAt: date(row.createdAt, "createdAt"),
  updatedAt: date(row.updatedAt, "updatedAt"),
});
const consentHistory = (row: PlannedConsentHistory): PlannedConsentHistory => ({
  ...row,
  metadata: record(row.metadata),
  createdAt: date(row.createdAt, "createdAt"),
});
const gdprRequest = (row: PlannedGdprRequest): PlannedGdprRequest => ({
  ...row,
  requestedAt: date(row.requestedAt, "requestedAt"),
  processedAt: optionalDate(row.processedAt, "processedAt"),
  expiresAt: optionalDate(row.expiresAt, "expiresAt"),
  metadata: record(row.metadata),
  createdAt: date(row.createdAt, "createdAt"),
  updatedAt: date(row.updatedAt, "updatedAt"),
});
const userConsentState = ({
  createdAt: _created,
  updatedAt: _updated,
  ...state
}: PlannedUserConsent) => state;
const cookieState = ({
  id: _id,
  createdAt: _created,
  updatedAt: _updated,
  ...state
}: ExistingCookieConsent) => state;
const gdprState = ({ createdAt: _created, updatedAt: _updated, ...state }: PlannedGdprRequest) =>
  state;
const gdprIdentity = (row: PlannedGdprRequest) =>
  `${row.userId}:${row.requestType}:${row.requestedAt}`;
