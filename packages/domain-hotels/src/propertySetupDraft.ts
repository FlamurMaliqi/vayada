import type { SetupTrack } from "./adaptiveHotelSetup.js";

export const PROPERTY_SETUP_DRAFT_CONTRACT_VERSION = "property-setup-draft.v1" as const;
export const PROPERTY_SETUP_ACTIVE_RETENTION_DAYS = 90;
export const PROPERTY_SETUP_COMPLETED_RETENTION_DAYS = 30;
export const PROPERTY_SETUP_DRAFT_PII_CLASSIFICATION = "potential_incidental_pii" as const;
export type PropertySetupStepPermission =
  | "hotel_catalog.setup.manage"
  | "marketplace.profile.manage"
  | "booking.settings.manage"
  | "pms.operations.manage";

export const PROPERTY_SETUP_STEP_DEFINITIONS = [
  {
    stepId: "present_hotel",
    track: "shared",
    permission: "hotel_catalog.setup.manage",
    baseRevisionKeys: ["hotel_catalog.profile", "hotel_catalog.media", "hotel_catalog.amenities"],
    fields: [
      "profile.default_locale",
      "profile.short_description",
      "profile.hero_image",
      "profile.gallery_images",
      "profile.amenities",
    ],
  },
  {
    stepId: "marketplace_preferences",
    track: "creator_marketplace",
    permission: "marketplace.profile.manage",
    baseRevisionKeys: ["marketplace.collaboration_preferences"],
    fields: [
      "marketplace.preferences.compensation_types",
      "marketplace.preferences.content_platforms",
      "marketplace.preferences.content_types",
      "marketplace.preferences.availability",
    ],
  },
  {
    stepId: "booking_design",
    track: "hotel_operations",
    permission: "booking.settings.manage",
    baseRevisionKeys: ["booking.design", "hotel_catalog.profile", "hotel_catalog.media"],
    fields: ["booking.primary_color", "booking.font_pairing"],
  },
  {
    stepId: "rooms",
    track: "hotel_operations",
    permission: "pms.operations.manage",
    baseRevisionKeys: ["pms.room_types", "pms.room_units", "pms.room_media"],
    fields: [
      "room.name",
      "room.category",
      "room.max_occupancy",
      "room.max_adults",
      "room.max_children",
      "room.beds",
      "room.bedrooms",
      "room.bathrooms",
      "room.bathroom_type",
      "room.size",
      "room.description",
      "room.unit_count",
      "room.images",
      "room.amenities",
    ],
  },
  {
    stepId: "pricing",
    track: "hotel_operations",
    permission: "pms.operations.manage",
    baseRevisionKeys: ["pms.pricing_settings", "pms.rate_plans", "pms.rate_rules"],
    fields: [
      "rate.currency",
      "rate.base_nightly_rate",
      "rate.free_cancellation_deadline_days",
      "rate.non_refundable_enabled",
      "rate.non_refundable_discount",
      "rate.seasons",
      "rate.seasonal_prices",
      "rate.weekend_days",
      "rate.weekend_surcharge",
      "rate.occupancy_prices",
      "rate.mandatory_charges_acknowledged",
    ],
  },
  {
    stepId: "calendar",
    track: "hotel_operations",
    permission: "pms.operations.manage",
    baseRevisionKeys: [
      "pms.operating_calendar",
      "pms.inventory",
      "pms.room_types",
      "hotel_catalog.location",
    ],
    fields: ["rate.operating_periods", "rate.minimum_stay", "rate.initial_availability"],
  },
  {
    stepId: "guest_experience",
    track: "hotel_operations",
    permission: "booking.settings.manage",
    baseRevisionKeys: [
      "booking.guest_experience",
      "pms.pricing_settings",
      "pms.rate_plans",
      "pms.room_types",
      "hotel_catalog.location",
      "hotel_catalog.policy",
    ],
    fields: [
      "guest.default_language",
      "guest.children_enabled",
      "guest.adult_age_threshold",
      "guest.phone_required",
      "guest.arrival_time_enabled",
      "guest.special_requests_enabled",
      "policy.check_in_time",
      "policy.check_out_time",
      "policy.cancellation_bundle_confirmation",
    ],
  },
  {
    stepId: "payments",
    track: "hotel_operations",
    permission: "booking.settings.manage",
    baseRevisionKeys: ["finance.payment_methods", "pms.pricing_settings"],
    fields: ["payment.accepted_methods"],
  },
  {
    stepId: "review",
    track: "shared",
    permission: "hotel_catalog.setup.manage",
    baseRevisionKeys: [],
    fields: [],
  },
] as const satisfies readonly {
  stepId: string;
  track: "shared" | SetupTrack;
  permission: PropertySetupStepPermission;
  baseRevisionKeys: readonly string[];
  fields: readonly string[];
}[];

export type PropertySetupStepDefinition = (typeof PROPERTY_SETUP_STEP_DEFINITIONS)[number];
export type PropertySetupStepId = PropertySetupStepDefinition["stepId"];
type DefinitionFor<TStepId extends PropertySetupStepId> = Extract<
  PropertySetupStepDefinition,
  { stepId: TStepId }
>;
type FieldFor<TStepId extends PropertySetupStepId> = DefinitionFor<TStepId>["fields"][number];
type BaseRevisionKeyFor<TStepId extends PropertySetupStepId> =
  DefinitionFor<TStepId>["baseRevisionKeys"][number];
export type PropertySetupFieldId = PropertySetupStepDefinition["fields"][number];
export type PropertySetupBaseRevisionKey = PropertySetupStepDefinition["baseRevisionKeys"][number];
export type PropertySetupBaseRevisionManifest = Readonly<
  Partial<Record<PropertySetupBaseRevisionKey, string>>
>;
export type PropertySetupDraftPayload<TStepId extends PropertySetupStepId> = [
  FieldFor<TStepId>,
] extends [never]
  ? Readonly<Record<string, never>>
  : Readonly<Partial<Record<FieldFor<TStepId>, JsonValue>>>;
export type PropertySetupBaseRevisions<TStepId extends PropertySetupStepId> = [
  BaseRevisionKeyFor<TStepId>,
] extends [never]
  ? Readonly<Record<string, never>>
  : Readonly<Record<BaseRevisionKeyFor<TStepId>, string>>;

export type SavePropertySetupDraftRequest = {
  [TStepId in PropertySetupStepId]: {
    stepId: TStepId;
    payload: PropertySetupDraftPayload<TStepId>;
    dirtyFields: FieldFor<TStepId>[];
    /** Source manifest to persist for resume and later canonical-apply validation. */
    expectedBaseRevisions: PropertySetupBaseRevisions<TStepId>;
    expectedTrackRevision: number;
    expectedSessionRevision: number;
    expectedDraftRevision: number;
  };
}[PropertySetupStepId];

/**
 * Secret-safe save acknowledgement. Draft payload values deliberately never
 * enter idempotency or audit metadata.
 */
export type SavePropertySetupDraftReceipt = {
  contractVersion: typeof PROPERTY_SETUP_DRAFT_CONTRACT_VERSION;
  sessionId: string;
  stepId: PropertySetupStepId;
  selectedTracks: SetupTrack[];
  trackRevision: number;
  sessionRevision: number;
  draftRevision: number;
  retentionExpiresAt: string;
  updatedAt: string;
  replayed: boolean;
};

export type SavePropertySetupDraftError =
  | { code: "setup_scope_unavailable" }
  | { code: "inactive_setup_step"; currentTrackRevision: number }
  | { code: "track_revision_conflict"; currentTrackRevision: number }
  | { code: "session_revision_conflict"; currentSessionRevision: number }
  | { code: "draft_revision_conflict"; currentDraftRevision: number }
  | { code: "setup_session_expired"; currentSessionRevision: number }
  | { code: "setup_draft_expired"; currentDraftRevision: number }
  | { code: "idempotency_key_conflict" }
  | { code: "command_in_progress" };

export type SavePropertySetupDraftResult =
  | { ok: true; receipt: SavePropertySetupDraftReceipt }
  | { ok: false; error: SavePropertySetupDraftError };

export type PropertySetupStepDraft = {
  [TStepId in PropertySetupStepId]: {
    stepId: TStepId;
    payload: PropertySetupDraftPayload<TStepId>;
    dirtyFields: FieldFor<TStepId>[];
    /** Revalidate against current owner revisions before applying canonical writes. */
    baseRevisions: PropertySetupBaseRevisions<TStepId>;
    piiClassification: typeof PROPERTY_SETUP_DRAFT_PII_CLASSIFICATION;
    retentionExpiresAt: string;
    revision: number;
    updatedAt: string;
  };
}[PropertySetupStepId];

export type PropertySetupSession = {
  contractVersion: typeof PROPERTY_SETUP_DRAFT_CONTRACT_VERSION;
  sessionId: string;
  organizationId: string;
  propertyId: string;
  selectedTracks: SetupTrack[];
  trackRevision: number;
  revision: number;
  resumeStepId: PropertySetupStepId | null;
  /** Updated only by a server-validated step command; saving a draft never adds entries. */
  completedStepIds: PropertySetupStepId[];
  drafts: PropertySetupStepDraft[];
  retentionExpiresAt: string;
};

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const PROPERTY_SETUP_BASE_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isPropertySetupBaseRevisionManifest(
  stepId: PropertySetupStepId,
  value: unknown,
): value is PropertySetupBaseRevisionManifest {
  const definition = PROPERTY_SETUP_STEP_DEFINITIONS.find((step) => step.stepId === stepId);
  if (!definition || !isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === definition.baseRevisionKeys.length &&
    keys.every((key) => typeof key === "string") &&
    definition.baseRevisionKeys.every((key) => Object.hasOwn(value, key)) &&
    Object.values(value).every(
      (revision) =>
        typeof revision === "string" && PROPERTY_SETUP_BASE_REVISION_PATTERN.test(revision),
    )
  );
}

export function getActivePropertySetupStepIds(
  selectedTracks: readonly SetupTrack[],
): PropertySetupStepId[] {
  const selected = new Set(selectedTracks);
  return PROPERTY_SETUP_STEP_DEFINITIONS.filter(({ track }) =>
    track === "shared" ? selected.size > 0 : selected.has(track),
  ).map(({ stepId }) => stepId);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    })
  );
}
