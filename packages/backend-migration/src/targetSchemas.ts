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

// Rebuilds must also remove retired schemas that may exist in older local
// databases before replaying the immutable migration history.
export const DEFAULT_REBUILD_SCHEMAS = [...DEFAULT_TARGET_SCHEMAS, "intelligence"] as const;
