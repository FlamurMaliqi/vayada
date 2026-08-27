-- Migration: 0109_staff_permission_catalog
-- Owner: domain-identity (backend-auth, backend-authorization)
-- See: engineering/staff-access-authorization-contract.md, VAY-1085

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('pms.dashboard.read',            'pms',      'Read PMS arrivals and departures dashboard'),
  ('pms.dashboard.operations.read', 'pms',      'Read standard PMS operational dashboard cards'),
  ('pms.dashboard.finance.read',    'pms',      'Read financial cards on the PMS dashboard'),
  ('pms.calendar.read',             'pms',      'Read the PMS calendar'),
  ('pms.calendar.manage',           'pms',      'Manage the PMS calendar'),
  ('pms.reservation.read',          'pms',      'Read PMS reservation details'),
  ('pms.reservation.update',        'pms',      'Modify and check PMS reservations in or out'),
  ('pms.reservation.cancel',        'pms',      'Cancel PMS reservations'),
  ('pms.inbox.read',                'pms',      'Read the PMS guest inbox'),
  ('pms.inbox.reply',               'pms',      'Reply through the PMS guest inbox'),
  ('pms.room_status.read',          'pms',      'Read PMS room status'),
  ('pms.rooms_rates.read',          'pms',      'Read PMS rooms and rates'),
  ('pms.rooms_rates.manage',        'pms',      'Manage PMS rooms and rates'),
  ('pms.channel_manager.read',      'pms',      'Read PMS channel manager configuration'),
  ('pms.finance.read',              'pms',      'Read financial data in the PMS for a hotel'),
  ('pms.settings.read',             'pms',      'Read PMS settings'),
  ('pms.settings.manage',           'pms',      'Manage PMS settings'),
  ('pms.guest_contact.read',        'pms',      'Read guest email and phone fields'),
  ('booking.analytics.read',        'booking',  'Read booking analytics and direct booking performance aggregates'),
  ('booking.design.read',           'booking',  'Read Booking Design Studio configuration'),
  ('booking.design.manage',         'booking',  'Manage Booking Design Studio configuration'),
  ('booking.flow.read',             'booking',  'Read Booking Flow configuration'),
  ('booking.flow.manage',           'booking',  'Manage Booking Flow configuration'),
  ('booking.settings.read',         'booking',  'Read booking engine setup and settings summaries'),
  ('booking.settings.manage',       'booking',  'Manage booking engine settings for a hotel'),
  ('identity.staff.manage',         'identity', 'Invite and manage hotel staff membership access'),
  ('finance.billing.manage',        'finance',  'Manage hotel billing and plan settings')
ON CONFLICT (key) DO NOTHING;

WITH staff_permissions(permission_key) AS (
  VALUES
    ('pms.dashboard.read'),
    ('pms.dashboard.operations.read'),
    ('pms.dashboard.finance.read'),
    ('pms.calendar.read'),
    ('pms.calendar.manage'),
    ('pms.reservation.read'),
    ('pms.reservation.update'),
    ('pms.reservation.cancel'),
    ('pms.inbox.read'),
    ('pms.inbox.reply'),
    ('pms.room_status.read'),
    ('pms.rooms_rates.read'),
    ('pms.rooms_rates.manage'),
    ('pms.channel_manager.read'),
    ('pms.finance.read'),
    ('pms.settings.read'),
    ('pms.settings.manage'),
    ('pms.guest_contact.read'),
    ('booking.analytics.read'),
    ('booking.design.read'),
    ('booking.design.manage'),
    ('booking.flow.read'),
    ('booking.flow.manage'),
    ('booking.settings.read'),
    ('booking.settings.manage'),
    ('identity.staff.manage'),
    ('finance.billing.manage')
),
role_defaults(role_key, permission_key) AS (
  SELECT role.role_key, permission.permission_key
  FROM staff_permissions permission
  CROSS JOIN (VALUES ('hotel_owner'), ('owner'), ('hotel_manager')) AS role(role_key)
  WHERE role.role_key <> 'hotel_manager'
     OR permission.permission_key NOT IN ('identity.staff.manage', 'finance.billing.manage')

  UNION ALL

  SELECT * FROM (VALUES
    ('front_desk', 'pms.dashboard.read'),
    ('front_desk', 'pms.dashboard.operations.read'),
    ('front_desk', 'pms.calendar.read'),
    ('front_desk', 'pms.calendar.manage'),
    ('front_desk', 'pms.reservation.read'),
    ('front_desk', 'pms.reservation.update'),
    ('front_desk', 'pms.inbox.read'),
    ('front_desk', 'pms.inbox.reply'),
    ('front_desk', 'pms.room_status.read'),
    ('front_desk', 'pms.rooms_rates.read'),
    ('front_desk', 'pms.guest_contact.read'),
    ('housekeeping', 'pms.dashboard.read'),
    ('housekeeping', 'pms.calendar.read'),
    ('housekeeping', 'pms.room_status.read')
  ) AS exact_defaults(role_key, permission_key)
),
removed_unexpected_defaults AS (
  DELETE FROM identity.role_permission_grants grant_row
  USING staff_permissions permission
  WHERE grant_row.organization_kind = 'hotel_group'
    AND grant_row.role_key IN ('hotel_manager', 'front_desk', 'housekeeping', 'hotel_custom')
    AND grant_row.permission_key = permission.permission_key
    AND NOT EXISTS (
      SELECT 1
      FROM role_defaults expected
      WHERE expected.role_key = grant_row.role_key
        AND expected.permission_key = grant_row.permission_key
    )
  RETURNING grant_row.role_key
)
INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key)
SELECT 'hotel_group', role_key, permission_key
FROM role_defaults
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;
