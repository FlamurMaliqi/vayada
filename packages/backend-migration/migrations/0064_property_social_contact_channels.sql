ALTER TABLE hotel_catalog.property_contact_channels
  DROP CONSTRAINT IF EXISTS property_contact_channels_channel_type_check;

ALTER TABLE hotel_catalog.property_contact_channels
  DROP CONSTRAINT IF EXISTS chk_property_contact_channels_channel_type;

ALTER TABLE hotel_catalog.property_contact_channels
  ADD CONSTRAINT chk_property_contact_channels_channel_type
  CHECK (
    channel_type IN (
      'phone',
      'email',
      'whatsapp',
      'website',
      'instagram',
      'facebook',
      'tiktok',
      'youtube',
      'x'
    )
  );
