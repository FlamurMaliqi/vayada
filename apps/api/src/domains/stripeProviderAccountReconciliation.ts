import type { StripeConnectProviderAccountSnapshot } from "@vayada/domain-finance";
import type { QueryResult, QueryResultRow } from "pg";

import { PROJECT_PUBLIC_BOOKABILITY_PROFILE } from "../platform/publicBookabilityPublication.js";

type StripeProviderAccountReconciliationClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export type StripeProviderAccountReconciliationState = {
  providerAccountId: string;
  propertyId: string;
  status: "active" | "setup_incomplete";
  onboardingStatus: "completed" | "invited";
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  cardPaymentsStatus: string | null;
};

export async function applyStripeProviderAccountSnapshot(
  client: StripeProviderAccountReconciliationClient,
  input: {
    snapshot: StripeConnectProviderAccountSnapshot;
    propertyId?: string;
    providerAccountId?: string;
    cardPaymentsReady?: boolean;
    metadata?: Record<string, unknown>;
  },
): Promise<StripeProviderAccountReconciliationState | null> {
  const snapshot = input.snapshot;
  const cardPaymentsReady = input.cardPaymentsReady ?? snapshot.cardPaymentsStatus === "active";
  const updated = await client.query<StripeProviderAccountReconciliationState>(
    `UPDATE finance.payment_provider_accounts account
     SET status = CASE
           WHEN $2::boolean AND $3::boolean AND $4::boolean AND $7::boolean THEN 'active'
           ELSE 'setup_incomplete'
         END,
         onboarding_status = CASE WHEN $4::boolean THEN 'completed' ELSE 'invited' END,
         charges_enabled = $2::boolean,
         payouts_enabled = $3::boolean,
         default_currency = COALESCE(NULLIF(upper($5), ''), default_currency),
         account_metadata = account_metadata || $6::jsonb,
         updated_at = now()
     WHERE account.provider = 'stripe'
       AND account.provider_account_id = $1
       AND ($8::uuid IS NULL OR account.property_id = $8::uuid)
       AND ($9::uuid IS NULL OR account.id = $9::uuid)
       AND ($8::uuid IS NULL OR EXISTS (
         SELECT 1
         FROM finance.payment_settings settings
         WHERE settings.property_id = $8::uuid
           AND settings.provider_account_id = account.id
       ))
     RETURNING
       id::text AS "providerAccountId",
       property_id::text AS "propertyId",
       status,
       onboarding_status AS "onboardingStatus",
       charges_enabled AS "chargesEnabled",
       payouts_enabled AS "payoutsEnabled",
       (account_metadata ->> 'detailsSubmitted')::boolean AS "detailsSubmitted",
       account_metadata ->> 'cardPaymentsStatus' AS "cardPaymentsStatus"`,
    [
      snapshot.providerAccountRef,
      snapshot.chargesEnabled,
      snapshot.payoutsEnabled,
      snapshot.detailsSubmitted,
      snapshot.defaultCurrency ?? "",
      JSON.stringify({
        ...input.metadata,
        detailsSubmitted: snapshot.detailsSubmitted,
        cardPaymentsStatus: snapshot.cardPaymentsStatus,
      }),
      cardPaymentsReady,
      input.propertyId ?? null,
      input.providerAccountId ?? null,
    ],
  );
  const state = updated.rows[0];
  if (!state) return null;

  const publicProfile = await client.query<{ canonicalUrl: string; bookingBaseUrl: string }>(
    `SELECT canonical_url AS "canonicalUrl", booking_base_url AS "bookingBaseUrl"
     FROM distribution.public_hotel_bookability_profiles
     WHERE property_id = $1::uuid`,
    [state.propertyId],
  );
  const urls = publicProfile.rows[0];
  if (urls) {
    await client.query(PROJECT_PUBLIC_BOOKABILITY_PROFILE, [
      state.propertyId,
      urls.canonicalUrl,
      urls.bookingBaseUrl,
    ]);
  }
  return state;
}
