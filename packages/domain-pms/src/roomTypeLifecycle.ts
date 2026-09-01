export const PMS_ROOM_TYPE_LIFECYCLE_CONTRACT_VERSION = "pms-room-type-lifecycle.v1" as const;

/**
 * The complete room-type-owned snapshot copied by duplication. Media objects
 * stay Platform-owned; only their PMS assignment references are copied.
 * Canonical pricing has its own revisioned authoring contracts and is not
 * inferred or cloned by this command.
 */
export const PMS_ROOM_TYPE_DUPLICATION_COPIED_FACTS = [
  "name_with_copy_suffix",
  "description",
  "category",
  "occupancy_limits",
  "room_attributes",
  "location_summary",
  "amenities_snapshot",
  "legacy_media_snapshot",
  "room_media_assignments",
  "legacy_base_rate_and_currency",
  "legacy_rate_plan_configuration",
  "legacy_dated_rate_rules",
] as const;

export const PMS_ROOM_TYPE_DUPLICATION_RESET_FACTS = [
  "room_type_identity",
  "setup_draft_binding",
  "source_identity",
  "fact_media_amenity_and_unit_revisions",
  "amenity_review_state",
  "physical_units",
  "inventory_days_and_reservations",
  "booking_assignments_and_room_blocks",
  "linked_inventory_membership",
  "canonical_pricing_source_bindings",
  "channel_provider_mappings",
  "publication_snapshots",
  "audit_and_delivery_history",
] as const;

export const PMS_ROOM_TYPE_RETIREMENT_BLOCKER_CATEGORIES = [
  "reservations",
  "physical_units",
  "inventory",
  "publication",
] as const;

export type PmsRoomTypeRetirementBlockerCategory =
  (typeof PMS_ROOM_TYPE_RETIREMENT_BLOCKER_CATEGORIES)[number];

export type PmsRoomTypeRetirementBlocker = {
  readonly category: PmsRoomTypeRetirementBlockerCategory;
  readonly code:
    | "active_reservations"
    | "active_physical_units"
    | "future_inventory"
    | "active_publication";
  readonly affectedCount: number;
  readonly action: string;
};

export type PmsRoomTypeRetirementImpact = {
  readonly contractVersion: typeof PMS_ROOM_TYPE_LIFECYCLE_CONTRACT_VERSION;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly version: string;
  readonly canRetire: boolean;
  readonly blockers: readonly PmsRoomTypeRetirementBlocker[];
};
