-- Migration: 0043_platform_media_object_property_index
-- Owner: platform-media
-- vayada:no-transaction
--
-- Building the unique index concurrently avoids blocking writes while
-- existing objects are read. Dropping first makes a retry recover an invalid
-- index left by an interrupted concurrent build.

DROP INDEX CONCURRENTLY IF EXISTS platform.uq_platform_media_objects_id_property;

-- vayada:next-statement
CREATE UNIQUE INDEX CONCURRENTLY uq_platform_media_objects_id_property
  ON platform.media_objects (id, property_id);
