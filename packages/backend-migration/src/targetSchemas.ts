export const DEFAULT_TARGET_SCHEMAS = [
  "platform",
  "identity",
  "hotel_catalog",
  "booking",
  "pms",
  "finance",
  "marketplace",
  "distribution",
] as const;

export const SOURCE_EXTRACTION_SCHEMAS = [
  "migration_source_auth",
  "migration_source_booking",
  "migration_source_marketplace",
  "migration_source_pms",
] as const;

// Rebuilds must also remove retired schemas that may exist in older local
// databases and raw extraction data before replaying the immutable history.
export const DEFAULT_REBUILD_SCHEMAS = [
  ...DEFAULT_TARGET_SCHEMAS,
  ...SOURCE_EXTRACTION_SCHEMAS,
  "intelligence",
] as const;
