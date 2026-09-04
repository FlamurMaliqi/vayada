export const GOOGLE_FREE_BOOKING_LINKS_SOURCE_FINGERPRINT_SQL = `md5(concat_ws('|',
  property.display_name,
  COALESCE(property.property_type, ''),
  COALESCE(location.country_code::text, ''),
  COALESCE(location.city, ''),
  COALESCE(location.street_address, ''),
  COALESCE(location.postal_code, ''),
  COALESCE(location.latitude::text, ''),
  COALESCE(location.longitude::text, ''),
  COALESCE(location.timezone, ''),
  COALESCE(profile.booking_base_url, ''),
  COALESCE(profile.custom_domain_url, ''),
  COALESCE(profile.default_currency::text, ''),
  COALESCE((
    SELECT string_agg(concat_ws(':', contact.id::text, contact.channel_type,
      contact.value, contact.is_public::text), ',' ORDER BY contact.id)
    FROM hotel_catalog.property_contact_channels contact
    WHERE contact.property_id = property.id
  ), ''),
  COALESCE((
    SELECT string_agg(concat_ws(':', room.id::text, room.name, room.currency,
      room.active::text, room.occupancy_limits::text, room.sort_order::text,
      (SELECT count(*)::text FROM pms.rooms unit
       WHERE unit.room_type_id = room.id AND unit.status <> 'retired')),
      ',' ORDER BY room.id)
    FROM pms.room_types room WHERE room.property_id = property.id
  ), ''),
  COALESCE((
    SELECT string_agg(concat_ws(':', plan.id::text, plan.room_type_id::text,
      plan.name, plan.currency, plan.active::text, plan.base_rate_amount::text),
      ',' ORDER BY plan.id)
    FROM pms.rate_plans plan WHERE plan.property_id = property.id
  ), '')
))`;
