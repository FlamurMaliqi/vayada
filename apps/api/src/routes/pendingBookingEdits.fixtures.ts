import type pg from "pg";
export const propertyId = "95900000-0000-4000-8000-000000000001";
export const roomTypeId = "95900000-0000-4000-8000-000000000002";
export const addonId = "95900000-0000-4000-8000-000000000003";
export async function seedProperty(admin: pg.Pool): Promise<void> {
  await admin.query(
    `INSERT INTO hotel_catalog.properties
         (id, public_id, display_name, profile_status, lifecycle_status)
       VALUES ($1::uuid, 'vay-959-hotel', 'VAY-959 Hotel', 'complete', 'active')`,
    [propertyId],
  );
  await admin.query(
    `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
       VALUES ($1::uuid, 'vay-959-hotel', 'canonical', 'active')`,
    [propertyId],
  );
  await admin.query(
    `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
         VALUES ($1::uuid, 'Europe/Athens')`,
    [propertyId],
  );
  await admin.query(
    `INSERT INTO hotel_catalog.property_public_profile_read_model
         (property_id, public_id, display_name, canonical_slug,
          default_locale, supported_locales, profile_status)
       VALUES ($1::uuid, 'vay-959-hotel', 'VAY-959 Hotel', 'vay-959-hotel',
               'en', ARRAY['en'], 'complete')`,
    [propertyId],
  );
  await admin.query(
    `INSERT INTO finance.payment_settings
         (property_id, payments_enabled, accepted_methods, default_currency)
       VALUES ($1::uuid, TRUE, ARRAY['pay_at_property', 'cash'], 'EUR')`,
    [propertyId],
  );
  await admin.query(
    `INSERT INTO booking.booking_settings
         (property_id, acceptance_mode, phone_required, default_currency)
       VALUES ($1::uuid, 'request', FALSE, 'EUR')`,
    [propertyId],
  );
  await admin.query(
    `INSERT INTO booking.addon_definitions
         (id, property_id, source_addon_id, name, pricing_model, price_amount,
          currency, ownership_kind, partner_commission_rate)
       VALUES ($1::uuid, $2::uuid, 'spa_partner', 'Partner spa', 'per_guest', 10.25,
               'EUR', 'partner', 18.75)`,
    [addonId, propertyId],
  );
  await admin.query(
    `INSERT INTO distribution.public_hotel_bookability_profiles
         (property_id, finance_payment_settings_property_id, public_id, canonical_slug,
          canonical_url, booking_base_url, timezone, default_currency,
          supported_currencies, profile_status, freshness_status,
          capabilities, public_setup_completeness, data_sources)
       VALUES (
         $1::uuid, $1::uuid, 'vay-959-hotel', 'vay-959-hotel',
         'https://booking.example.test/vay-959-hotel', 'https://booking.example.test',
         'Europe/Athens', 'EUR', ARRAY['EUR'], 'public', 'fresh',
         '{"paymentMethods":["pay_at_property"]}'::jsonb, '{"status":"ready"}'::jsonb,
         ARRAY['hotel_catalog', 'booking', 'pms', 'finance', 'distribution']
       )`,
    [propertyId],
  );
  await admin.query(
    `INSERT INTO pms.room_types
         (id, property_id, name, occupancy_limits, base_rate_amount, currency)
       VALUES ($1::uuid, $2::uuid, 'VAY-959 Room', '{"adults":2,"total":2}', 100, 'EUR')`,
    [roomTypeId, propertyId],
  );
  // prettier-ignore
  await admin.query(`BEGIN; SET LOCAL session_replication_role=replica; INSERT INTO pms.operating_calendar_revisions (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,property_time_zone,schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at) VALUES (gen_random_uuid(),'${propertyId}',1,'pms-operating-calendar.v1',1,'Europe/Athens','year_round',0,1,1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now(),now()); INSERT INTO pms.operating_calendar_room_bindings (property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,physical_capacity_count,starting_sellable_limit_count) VALUES ('${propertyId}',1,'${roomTypeId}',1,1,2,2); COMMIT;`);
  await admin.query(
    `INSERT INTO pms.inventory_days
         (property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,
          inventory_revision,generated_sellable_limit_count,effective_sellable_limit_count,
          generated_source_revision,channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
       SELECT $1::uuid,$2::uuid,stay_date,2,2,1,1,2,2,1,0,0,0,0
       FROM unnest(ARRAY[DATE '2027-02-01', DATE '2027-02-02', DATE '2027-02-03', DATE '2027-02-04']) AS stay_date`,
    [propertyId, roomTypeId],
  );
  await admin.query(
    `INSERT INTO distribution.public_room_offer_snapshots
         (property_id, room_type_id, stay_date, public_offer_key, available_rooms,
          base_price_amount, currency, payment_options, freshness_status)
       SELECT $1::uuid, $2::uuid, stay_date, 'vay-959-flex', 2,
              100, 'EUR', ARRAY['pay_at_property'], 'fresh'
       FROM unnest(ARRAY[DATE '2027-02-01', DATE '2027-02-02', DATE '2027-02-03', DATE '2027-02-04']) AS stay_date`,
    [propertyId, roomTypeId],
  );
  await admin.query(
    `UPDATE distribution.public_room_offer_snapshots SET rate_summary='{"rateType":"flexible"}'::jsonb WHERE property_id=$1::uuid`,
    [propertyId],
  );
}

export async function seedQuote(
  admin: pg.Pool,
  id: string,
  reference: string,
  quotedAddonId: string,
): Promise<void> {
  await admin.query(
    `INSERT INTO booking.quote_sessions
         (id, property_id, request_hash, public_quote_reference,
          requested_check_in, requested_check_out, adults, children,
          requested_room_count, currency, selected_offer_snapshot, totals,
          policy_snapshot, expires_at)
       VALUES (
         $1::uuid, $2::uuid, $3, $4,
         DATE '2027-02-01', DATE '2027-02-03', 2, 0,
         1, 'EUR',
         jsonb_build_object(
           'roomTypeId', $5::text,
           'publicOfferKey', 'vay-959-flex',
           'paymentMethod', 'pay_at_property',
           'acceptanceMode', 'request',
           'addonRequest', jsonb_build_object(
             'addonIds', jsonb_build_array('spa_partner'),
             'addonQuantities', '{"spa_partner":2}'::jsonb,
             'addonDates', '{}'::jsonb
           ),
           'addonPurchases', jsonb_build_array(jsonb_build_object(
             'addonDefinitionId', $6::text,
             'addonSnapshot', jsonb_build_object(
               'addonDefinitionId', $6::text,
               'sourceAddonId', 'spa_partner',
               'name', 'Partner spa',
               'pricingModel', 'per_guest',
               'unitAmount', '10.25',
               'currency', 'EUR'
             ),
             'quantity', 2,
             'serviceDate', '2027-02-01',
             'totalAmount', '20.50',
             'currency', 'EUR',
             'ownershipKind', 'partner',
             'partnerCommissionRate', '18.7500'
           ))
         ),
         '{"roomTotal":"200.00","addonTotal":"20.50","totalAmount":"220.50","balanceAmount":"220.50"}'::jsonb,
         '{}'::jsonb, TIMESTAMPTZ '2027-01-02T10:00:00Z'
       )`,
    [id, propertyId, `hash-${reference}`, reference, roomTypeId, quotedAddonId],
  );
}

export async function cleanup(admin: pg.Pool): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const statement of [
      "DELETE FROM booking.pending_booking_edit_attempts WHERE property_id=$1::uuid",
      "DELETE FROM booking.edit_authorization_releases WHERE property_id=$1::uuid",
      "DELETE FROM finance.payments WHERE property_id=$1::uuid",
      "DELETE FROM finance.online_card_execution_evidence WHERE property_id=$1::uuid",
      "DELETE FROM finance.payment_provider_accounts WHERE property_id=$1::uuid",
      "WITH s AS (DELETE FROM pms.inventory_reservation_statuses WHERE property_id=$1::uuid), w AS (DELETE FROM pms.inventory_reservation_day_watermarks WHERE property_id=$1::uuid), r AS (DELETE FROM pms.inventory_reservation_receipts WHERE property_id=$1::uuid) DELETE FROM platform.outbox_events WHERE property_id=$1::uuid",
      "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
      "DELETE FROM platform.jobs WHERE property_id = $1::uuid",
      "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
      "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
      "DELETE FROM booking.direct_booking_summary_read_model WHERE property_id = $1::uuid",
      `DELETE FROM booking.booking_status_events
           WHERE guest_booking_id IN (
             SELECT id FROM booking.guest_bookings WHERE property_id = $1::uuid
           )`,
      `DELETE FROM booking.booking_guests
           WHERE guest_booking_id IN (
             SELECT id FROM booking.guest_bookings WHERE property_id = $1::uuid
           )`,
      "DELETE FROM booking.booking_addon_selections WHERE property_id = $1::uuid",
      "DELETE FROM booking.guest_bookings WHERE property_id = $1::uuid",
      "DELETE FROM booking.checkout_contexts WHERE property_id = $1::uuid",
      "DELETE FROM booking.quote_sessions WHERE property_id = $1::uuid",
      "DELETE FROM booking.addon_definitions WHERE property_id = $1::uuid",
      "DELETE FROM booking.same_day_booking_policies WHERE property_id = $1::uuid",
      "DELETE FROM distribution.public_room_offer_snapshots WHERE property_id = $1::uuid",
      "DELETE FROM pms.inventory_days WHERE property_id = $1::uuid",
      "WITH b AS (DELETE FROM pms.operating_calendar_room_bindings WHERE property_id=$1::uuid) DELETE FROM pms.operating_calendar_revisions WHERE property_id=$1::uuid",
      "DELETE FROM pms.room_types WHERE property_id = $1::uuid",
      "DELETE FROM distribution.public_hotel_bookability_profiles WHERE property_id = $1::uuid",
      "DELETE FROM booking.booking_settings WHERE property_id = $1::uuid",
      "DELETE FROM finance.payment_settings WHERE property_id = $1::uuid",
      "DELETE FROM hotel_catalog.property_slugs WHERE property_id = $1::uuid",
      "DELETE FROM hotel_catalog.property_locations WHERE property_id = $1::uuid",
      "DELETE FROM hotel_catalog.property_public_profile_read_model WHERE property_id = $1::uuid",
      "DELETE FROM hotel_catalog.properties WHERE id = $1::uuid",
    ]) {
      await client.query(statement, [propertyId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function enableCard(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role=replica");
    const account = (
      await client.query(
        `INSERT INTO finance.payment_provider_accounts
      (property_id,account_scope,provider,provider_account_id,status,onboarding_status,charges_enabled,payouts_enabled,default_currency,capabilities,account_metadata,card_capability_revision)
      VALUES ($1,'property','stripe','acct_vay959','active','completed',true,true,'EUR',ARRAY['card_payments'],
      '{"detailsSubmitted":true,"cardPaymentsStatus":"active"}',7) RETURNING id`,
        [propertyId],
      )
    ).rows[0].id;
    await client.query(
      `UPDATE finance.payment_settings SET provider_account_id=$2,accepted_methods=ARRAY['card','pay_at_property','cash'],
      payment_readiness_contract_version='finance-payment-readiness.v1',payment_methods_revision=1,source_pricing_currency_revision=1,online_card_readiness_revision=1
      WHERE property_id=$1`,
      [propertyId, account],
    );
    await client.query(
      `INSERT INTO finance.online_card_execution_evidence
      (property_id,provider_account_id,contract_version,test_suite,provider_capability_revision,property_readiness_revision,
       evidence_fingerprint_hash,executed_at,accepted_at,accepted_by_organization_id,accepted_by_user_id)
      VALUES ($1,$2,'finance-online-card-execution-evidence.v1','onb-25a',7,1,repeat('9',64),now(),now(),gen_random_uuid(),gen_random_uuid())`,
      [propertyId, account],
    );
    await client.query(
      `UPDATE distribution.public_hotel_bookability_profiles SET capabilities='{"paymentMethods":["card","pay_at_property"]}' WHERE property_id=$1`,
      [propertyId],
    );
    await client.query(
      `UPDATE distribution.public_room_offer_snapshots SET payment_options=ARRAY['card','pay_at_property'] WHERE property_id=$1`,
      [propertyId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
