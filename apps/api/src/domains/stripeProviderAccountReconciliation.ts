import type { StripeConnectProviderAccountSnapshot } from "@vayada/domain-finance";
import type { QueryResult, QueryResultRow } from "pg";

import { PROJECT_PUBLIC_BOOKABILITY_PROFILE } from "../platform/publicBookabilityPublication.js";
import {
  applyFinanceOnlineCardReadinessLoss,
  loadFinanceOnlineCardReadinessState,
  type FinanceOnlineCardReadinessChangeContext,
} from "./financeOnlineCardReadinessTransition.js";

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
  cardCapabilityRevision: number;
};

export type StripeProviderAccountReconciliationResult = StripeProviderAccountReconciliationState & {
  onlineCardReadinessLost: boolean;
};

export async function applyStripeProviderAccountSnapshot(
  client: StripeProviderAccountReconciliationClient,
  input: {
    snapshot: StripeConnectProviderAccountSnapshot;
    propertyId: string;
    providerAccountId: string;
    metadata?: Record<string, unknown>;
    readinessChange: FinanceOnlineCardReadinessChangeContext;
  },
): Promise<StripeProviderAccountReconciliationResult | null> {
  const snapshot = input.snapshot;
  const cardPaymentsReady = snapshot.cardPaymentsStatus === "active";
  const previousReadiness = await loadFinanceOnlineCardReadinessState(client, input.propertyId);
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
         capabilities = CASE
           WHEN $7::boolean THEN
             array_append(array_remove(capabilities, 'card_payments'), 'card_payments')
           ELSE array_remove(capabilities, 'card_payments')
         END,
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
       account_metadata ->> 'cardPaymentsStatus' AS "cardPaymentsStatus",
       card_capability_revision::int AS "cardCapabilityRevision"`,
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
      input.propertyId,
      input.providerAccountId,
    ],
  );
  const state = updated.rows[0];
  if (!state) return null;

  const onlineCardReadinessLost = await applyFinanceOnlineCardReadinessLoss(client, {
    propertyId: state.propertyId,
    previous: previousReadiness,
    context: input.readinessChange,
  });
  const currentReadiness =
    (await loadFinanceOnlineCardReadinessState(client, state.propertyId))?.ready === true;

  const publicProfile = await client.query<{
    canonicalUrl: string;
    bookingBaseUrl: string;
    cardPublished: boolean;
  }>(
    `SELECT profile.canonical_url AS "canonicalUrl",
            profile.booking_base_url AS "bookingBaseUrl",
            COALESCE(profile.capabilities -> 'paymentMethods' ? 'card', FALSE)
              AS "cardPublished"
     FROM distribution.public_hotel_bookability_profiles profile
     WHERE profile.property_id = $1::uuid`,
    [state.propertyId],
  );
  const urls = publicProfile.rows[0];
  if (urls?.cardPublished && !currentReadiness) {
    await client.query(PROJECT_PUBLIC_BOOKABILITY_PROFILE, [
      state.propertyId,
      urls.canonicalUrl,
      urls.bookingBaseUrl,
    ]);
  }
  return { ...state, onlineCardReadinessLost };
}
