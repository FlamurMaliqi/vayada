import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import { sortedBy } from "./productionIdentityOwnershipPolicy.js";
import {
  addBlocker,
  addDuplicateValueBlockers,
  assertKnownUser,
  bool,
  date,
  newestDate,
  optionalBool,
  optionalDate,
  optionalText,
  optionalUuid,
  parseAuthRows,
  stableJson,
  text,
  uniqueRows,
  uuid,
} from "./productionIdentitySourceValidation.js";

export type PlannedUserConsent = {
  userId: string;
  termsAcceptedAt: string | null;
  termsVersion: string | null;
  privacyAcceptedAt: string | null;
  privacyVersion: string | null;
  marketingConsent: boolean;
  marketingConsentAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type PlannedCookieConsent = {
  id: string;
  visitorId: string;
  userId: string | null;
  necessary: true;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
  createdAt: string;
  updatedAt: string;
};
export type IdentityConsentSourcePlan = {
  userConsents: PlannedUserConsent[];
  cookieConsents: PlannedCookieConsent[];
  retiredAuthRows: Record<string, number>;
  blockers: IdentityMigrationBlocker[];
};

export const RETIRED_AUTH_TABLES = [
  "email_change_tokens",
  "email_verification_codes",
  "email_verification_tokens",
  "login_rate_limit",
  "password_reset_tokens",
  "totp_recovery_codes",
  "totp_secrets",
] as const;

export function planIdentityConsentSource(
  rows: IdentitySourceRow[],
  knownUserIds: Iterable<string>,
): IdentityConsentSourcePlan {
  const users = new Set(knownUserIds);
  const blockers: IdentityMigrationBlocker[] = [];
  const userConsents = uniqueRows(
    parseAuthRows(rows, "users", blockers, (row) => {
      const userId = uuid(row.data["id"], "id");
      assertKnownUser(userId, users);
      const termsAcceptedAt = optionalDate(row.data["terms_accepted_at"], "terms_accepted_at");
      const privacyAcceptedAt = optionalDate(
        row.data["privacy_accepted_at"],
        "privacy_accepted_at",
      );
      const marketingConsentAt = optionalDate(
        row.data["marketing_consent_at"],
        "marketing_consent_at",
      );
      const createdAt = date(row.data["created_at"], "created_at");
      return {
        userId,
        termsAcceptedAt,
        termsVersion: optionalText(row.data["terms_version"], "terms_version"),
        privacyAcceptedAt,
        privacyVersion: optionalText(row.data["privacy_version"], "privacy_version"),
        marketingConsent: optionalBool(row.data["marketing_consent"], "marketing_consent") ?? false,
        marketingConsentAt,
        createdAt,
        updatedAt: newestDate(createdAt, termsAcceptedAt, privacyAcceptedAt, marketingConsentAt),
      };
    }),
    (row) => row.userId,
    "auth.users",
    "USER_CONSENT_CONFLICT",
    blockers,
  );

  const parsedCookies = parseAuthRows(rows, "cookie_consent", blockers, (row) => {
    const userId = optionalUuid(row.data["user_id"], "user_id");
    assertKnownUser(userId, users);
    if (bool(row.data["necessary"], "necessary") !== true)
      throw new Error("necessary must be true");
    const createdAt = date(row.data["created_at"], "created_at");
    return {
      id: uuid(row.data["id"], "id"),
      visitorId: text(row.data["visitor_id"], "visitor_id"),
      userId,
      necessary: true as const,
      functional: bool(row.data["functional"], "functional"),
      analytics: bool(row.data["analytics"], "analytics"),
      marketing: bool(row.data["marketing"], "marketing"),
      createdAt,
      updatedAt: newestDate(createdAt, date(row.data["updated_at"], "updated_at")),
    };
  });
  const latest = new Map<string, PlannedCookieConsent>();
  for (const row of parsedCookies) {
    const current = latest.get(row.visitorId);
    if (!current || Date.parse(row.updatedAt) > Date.parse(current.updatedAt))
      latest.set(row.visitorId, row);
    else if (Date.parse(row.updatedAt) === Date.parse(current.updatedAt)) {
      if (stableJson(row) !== stableJson(current))
        addBlocker(
          blockers,
          "COOKIE_STATE_CONFLICT",
          "auth.cookie_consent",
          row.visitorId,
          "Equal-freshness cookie rows disagree",
        );
      if (stableJson(row) < stableJson(current)) latest.set(row.visitorId, row);
    }
  }
  const cookieConsents = sortedBy([...latest.values()], (row) => row.visitorId);
  addDuplicateValueBlockers(
    cookieConsents,
    (row) => row.id,
    (row) => row.visitorId,
    "auth.cookie_consent",
    "COOKIE_ID_CONFLICT",
    blockers,
  );

  return {
    userConsents,
    cookieConsents,
    retiredAuthRows: Object.fromEntries(
      RETIRED_AUTH_TABLES.map((table) => [
        table,
        rows.filter((row) => row.sourceDatabase === "auth" && row.sourceTable === table).length,
      ]),
    ),
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
}
