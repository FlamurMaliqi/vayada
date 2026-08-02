export const PROPERTY_MEDIA_PUBLICATION_QUEUE = "hotel-catalog.property-media";
export const PROPERTY_MEDIA_PUBLICATION_JOB_TYPE = "hotel-catalog.property-media.publish";

/** SQL predicate for a `platform.jobs job` alias with the property UUID bound as `$1`. */
export const ACTIVE_PROPERTY_MEDIA_PUBLICATION_PREDICATE = `
  job.queue_name = '${PROPERTY_MEDIA_PUBLICATION_QUEUE}'
  AND job.job_type = '${PROPERTY_MEDIA_PUBLICATION_JOB_TYPE}'
  AND job.tenant_scope = 'property'
  AND job.property_id = $1::uuid
  AND job.resource_product = 'hotel_catalog'
  AND job.resource_type = 'property_media_assignment'
  AND job.resource_id = $1::uuid::text
  AND job.status IN ('pending', 'running')
`;

/** Approved canonical property-media object predicate for a `media_object` SQL alias. */
export const APPROVED_PUBLIC_PROPERTY_MEDIA_OBJECT_PREDICATE = `
  media_object.visibility = 'public'
  AND media_object.public_approved = TRUE
  AND media_object.lifecycle_status = 'active'
  AND media_object.purpose IN (
    'property.hero_image',
    'property.gallery_image',
    'property.logo',
    'pms.room_type.media'
  )
`;
