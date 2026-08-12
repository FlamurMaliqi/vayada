import { describe, expect, it } from "vitest";

import {
  ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION,
  SETUP_TRACK_COMPONENT_PRODUCTS,
  SETUP_TRACKS,
  isSetupTrack,
  isSetupTaskLaunchable,
  parseAdaptiveHotelSetupStatus,
  parseUpdateTracksRequest,
  type AdaptiveHotelSetupStatus,
  type SetupTask,
  type UpdateTracksRequest,
} from "./adaptiveHotelSetup.js";

describe("adaptive hotel setup contracts", () => {
  it("exposes only the two owner-facing setup tracks", () => {
    expect(SETUP_TRACKS).toEqual(["hotel_operations", "creator_marketplace"]);
    expect(isSetupTrack("hotel_operations")).toBe(true);
    expect(isSetupTrack("creator_marketplace")).toBe(true);
  });

  it.each(["pms", "booking", "marketplace", "unknown", null, undefined])(
    "rejects component product name %s as a setup track",
    (value) => {
      expect(isSetupTrack(value)).toBe(false);
    },
  );

  it("maps Hotel Operations to PMS and Booking as one bundle", () => {
    expect(SETUP_TRACK_COMPONENT_PRODUCTS).toEqual({
      hotel_operations: ["pms", "booking"],
      creator_marketplace: ["marketplace"],
    });
  });

  it("keeps canonical tracks and component mappings immutable at runtime", () => {
    expect(Object.isFrozen(SETUP_TRACKS)).toBe(true);
    expect(Object.isFrozen(SETUP_TRACK_COMPONENT_PRODUCTS)).toBe(true);
    expect(Object.isFrozen(SETUP_TRACK_COMPONENT_PRODUCTS.hotel_operations)).toBe(true);
    expect(Object.isFrozen(SETUP_TRACK_COMPONENT_PRODUCTS.creator_marketplace)).toBe(true);

    expect(() => (SETUP_TRACKS as unknown as string[]).push("booking")).toThrow(TypeError);
    expect(() =>
      (SETUP_TRACK_COMPONENT_PRODUCTS.hotel_operations as unknown as string[]).push("marketplace"),
    ).toThrow(TypeError);

    expect(isSetupTrack("booking")).toBe(false);
  });

  it("parses and canonicalizes an update request", () => {
    const request = parseUpdateTracksRequest({
      selectedTracks: ["creator_marketplace", "hotel_operations"],
      expectedRevision: 0,
    });

    expect(request).toEqual({
      selectedTracks: ["hotel_operations", "creator_marketplace"],
      expectedRevision: 0,
    } satisfies UpdateTracksRequest);
  });

  it.each([
    null,
    {},
    { selectedTracks: [], expectedRevision: 0 },
    { selectedTracks: ["hotel_operations", "hotel_operations"], expectedRevision: 0 },
    { selectedTracks: ["booking"], expectedRevision: 0 },
    { selectedTracks: ["hotel_operations"], expectedRevision: -1 },
    { selectedTracks: ["hotel_operations"], expectedRevision: 0.5 },
    { selectedTracks: ["hotel_operations"], expectedRevision: 2_147_483_647 },
    { selectedTracks: ["hotel_operations"], expectedRevision: "0" },
    { selectedTracks: ["hotel_operations"], expectedRevision: 0, unexpected: true },
  ])("rejects an invalid update request: %j", (value) => {
    expect(parseUpdateTracksRequest(value)).toBeNull();
  });

  it("rejects sparse setup-track arrays", () => {
    const selectedTracks: unknown[] = [];
    selectedTracks.length = 1;

    expect(parseUpdateTracksRequest({ selectedTracks, expectedRevision: 0 })).toBeNull();
  });

  it("parses a valid adaptive hotel setup status", () => {
    const status: AdaptiveHotelSetupStatus = {
      contractVersion: ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION,
      organization: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        displayName: "Alpenrose Hotel Group",
        websiteUrl: null,
        selectedTracks: ["hotel_operations"],
        trackRevision: 1,
        canManageTracks: true,
        tracks: [
          {
            track: "hotel_operations",
            provisioning: "active",
            components: [
              { product: "pms", access: "active" },
              { product: "booking", access: "active" },
            ],
            allowedActions: ["manage_service"],
          },
          {
            track: "creator_marketplace",
            provisioning: "not_selected",
            components: [{ product: "marketplace", access: "absent" }],
            allowedActions: ["add"],
          },
        ],
      },
      propertySelection: {
        state: "no_property",
        selectedPropertyId: null,
        availableProperties: [],
      },
      entryDecision: null,
      setupPlan: null,
      updatedAt: "2026-07-26T12:00:00.000Z",
    };

    expect(parseAdaptiveHotelSetupStatus(status)).toEqual(status);
  });

  it.each([
    { contractVersion: "shared-hotel-setup-status.v1" },
    { unexpected: true },
    { organization: { selectedTracks: ["booking"] } },
    { propertySelection: { state: "selected_property" } },
    { organization: { tracks: [{ provisioning: "ready" }] } },
    { entryDecision: { decision: "redirect" } },
    {
      entryDecision: {
        requestedProduct: "booking",
        propertyId: null,
        decision: "enter",
        destinationRouteKey: null,
        reasonCode: null,
      },
    },
    {
      organization: {
        selectedTracks: ["hotel_operations"],
        canManageTracks: true,
        tracks: [
          {
            track: "hotel_operations",
            provisioning: "active",
            components: [
              { product: "pms", access: "active" },
              { product: "booking", access: "suspended" },
            ],
            allowedActions: ["manage_service"],
          },
          {
            track: "creator_marketplace",
            provisioning: "not_selected",
            components: [{ product: "marketplace", access: "absent" }],
            allowedActions: ["add"],
          },
        ],
      },
    },
  ])("rejects malformed, contradictory, or unknown adaptive status fields: %j", (override) => {
    const valid = parseAdaptiveHotelSetupStatus({
      contractVersion: ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION,
      organization: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        displayName: "Alpenrose Hotel Group",
        websiteUrl: null,
        selectedTracks: [],
        trackRevision: 0,
        canManageTracks: false,
        tracks: [
          {
            track: "hotel_operations",
            provisioning: "not_selected",
            components: [
              { product: "pms", access: "absent" },
              { product: "booking", access: "absent" },
            ],
            allowedActions: [],
          },
          {
            track: "creator_marketplace",
            provisioning: "not_selected",
            components: [{ product: "marketplace", access: "absent" }],
            allowedActions: [],
          },
        ],
      },
      propertySelection: {
        state: "no_property",
        selectedPropertyId: null,
        availableProperties: [],
      },
      entryDecision: null,
      setupPlan: null,
      updatedAt: "2026-07-26T12:00:00.000Z",
    });
    expect(valid).not.toBeNull();

    const value = structuredClone(valid!);
    Object.assign(value, override);
    if (override.organization) Object.assign(value.organization, override.organization);
    if (override.propertySelection)
      Object.assign(value.propertySelection, override.propertySelection);
    if (override.entryDecision) value.entryDecision = override.entryDecision as never;

    expect(parseAdaptiveHotelSetupStatus(value)).toBeNull();
  });

  it("validates setup tasks and launch readiness against the selected tracks", () => {
    const value = {
      contractVersion: ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION,
      organization: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        displayName: "Alpenrose Hotel Group",
        websiteUrl: null,
        selectedTracks: ["hotel_operations"],
        trackRevision: 1,
        canManageTracks: true,
        tracks: [
          {
            track: "hotel_operations",
            provisioning: "active",
            components: [
              { product: "pms", access: "active" },
              { product: "booking", access: "active" },
            ],
            allowedActions: ["manage_service"],
          },
          {
            track: "creator_marketplace",
            provisioning: "not_selected",
            components: [{ product: "marketplace", access: "absent" }],
            allowedActions: ["add"],
          },
        ],
      },
      propertySelection: {
        state: "single_property",
        selectedPropertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        availableProperties: [
          {
            propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            publicId: "hotel-alpenrose",
            displayName: "Hotel Alpenrose",
            locationSummary: "Munich, DE",
          },
        ],
      },
      entryDecision: null,
      setupPlan: {
        propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        planRevision: "tracks:1",
        tasks: [
          {
            taskId: "shared_identity",
            track: "shared",
            requirementOwnerDomain: "hotel_catalog",
            destinationRouteKey: "hotel_catalog.shared_identity",
            actionableBy: "operator",
          },
          {
            taskId: "rooms_rates_availability",
            track: "hotel_operations",
            requirementOwnerDomain: "pms",
            destinationRouteKey: "pms.rooms_rates_availability",
            actionableBy: "operator",
          },
          {
            taskId: "guest_settings_policies",
            track: "hotel_operations",
            requirementOwnerDomain: "booking",
            destinationRouteKey: "booking.guest_settings_policies",
            actionableBy: "owner",
          },
          {
            taskId: "billing_plan",
            track: "hotel_operations",
            requirementOwnerDomain: "finance",
            destinationRouteKey: "finance.billing_plan",
            actionableBy: "owner",
          },
          {
            taskId: "payment",
            track: "hotel_operations",
            requirementOwnerDomain: "finance",
            destinationRouteKey: "finance.payment",
            actionableBy: "owner",
          },
          {
            taskId: "direct_booking_publication",
            track: "hotel_operations",
            requirementOwnerDomain: "distribution",
            destinationRouteKey: "distribution.direct_booking_publication",
            actionableBy: "owner",
          },
        ].map(
          (
            { taskId, track, requirementOwnerDomain, destinationRouteKey, actionableBy },
            index,
          ) => ({
            taskId,
            propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            track,
            requirementOwnerDomain,
            destinationRouteKey,
            callerCapability: "allowed",
            ownerProgress: "not_started",
            readiness: index === 0 ? "not_a_readiness" : "actionable",
            actionableBy,
            reasonCodes: [],
            sourceRevision: "1",
            freshness: "fresh",
            evaluatedAt: "2026-07-26T12:00:00.000Z",
          }),
        ),
        recommendedTaskId: "shared_identity",
        ownerProgress: { complete: 0, total: 6 },
        launchReadiness: {
          operationsUse: "pending",
          directBookingPublish: "pending",
          marketplacePublish: "not_applicable",
        },
      },
      updatedAt: "2026-07-26T12:00:00.000Z",
    };

    expect(parseAdaptiveHotelSetupStatus(value)).toBeNull();

    value.setupPlan.tasks[0]!.readiness = "actionable";
    expect(parseAdaptiveHotelSetupStatus(value)).not.toBeNull();

    value.setupPlan.tasks[0]!.readiness = "complete";
    value.setupPlan.tasks[0]!.ownerProgress = "owner_complete";
    value.setupPlan.ownerProgress.complete = 1;
    expect(parseAdaptiveHotelSetupStatus(value)).toBeNull();

    value.setupPlan.tasks[0]!.actionableBy = null as never;
    value.setupPlan.recommendedTaskId = "rooms_rates_availability";
    expect(parseAdaptiveHotelSetupStatus(value)).not.toBeNull();

    value.setupPlan.launchReadiness.marketplacePublish = "ready";
    expect(parseAdaptiveHotelSetupStatus(value)).toBeNull();

    value.setupPlan.launchReadiness.marketplacePublish = "not_applicable";
    value.setupPlan.tasks.push({
      ...value.setupPlan.tasks[0]!,
      taskId: "public_profile",
      track: "creator_marketplace",
    });
    value.setupPlan.ownerProgress.total = 7;
    expect(parseAdaptiveHotelSetupStatus(value)).toBeNull();
  });

  it("accepts a rejected Marketplace task as a correction recommendation", () => {
    const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const evaluatedAt = "2026-07-26T12:00:00.000Z";
    const task = (
      input: Pick<
        SetupTask,
        | "taskId"
        | "track"
        | "requirementOwnerDomain"
        | "destinationRouteKey"
        | "ownerProgress"
        | "readiness"
        | "actionableBy"
        | "reasonCodes"
      >,
    ): SetupTask => ({
      ...input,
      propertyId,
      callerCapability: "allowed",
      sourceRevision: `${input.taskId}-r1`,
      freshness: "fresh",
      evaluatedAt,
    });
    const status: AdaptiveHotelSetupStatus = {
      contractVersion: ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION,
      organization: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        displayName: "Alpenrose Hotel Group",
        websiteUrl: null,
        selectedTracks: ["creator_marketplace"],
        trackRevision: 1,
        canManageTracks: true,
        tracks: [
          {
            track: "hotel_operations",
            provisioning: "not_selected",
            components: [
              { product: "pms", access: "absent" },
              { product: "booking", access: "absent" },
            ],
            allowedActions: ["add"],
          },
          {
            track: "creator_marketplace",
            provisioning: "active",
            components: [{ product: "marketplace", access: "active" }],
            allowedActions: ["manage_service"],
          },
        ],
      },
      propertySelection: {
        state: "single_property",
        selectedPropertyId: propertyId,
        availableProperties: [
          {
            propertyId,
            publicId: "hotel-alpenrose",
            displayName: "Hotel Alpenrose",
            locationSummary: "Munich, DE",
          },
        ],
      },
      entryDecision: null,
      setupPlan: {
        propertyId,
        planRevision: "plan.v2:rejected-correction",
        tasks: [
          task({
            taskId: "shared_identity",
            track: "shared",
            requirementOwnerDomain: "hotel_catalog",
            destinationRouteKey: "hotel_catalog.shared_identity",
            ownerProgress: "owner_complete",
            readiness: "complete",
            actionableBy: null,
            reasonCodes: [],
          }),
          task({
            taskId: "public_profile",
            track: "creator_marketplace",
            requirementOwnerDomain: "hotel_catalog",
            destinationRouteKey: "hotel_catalog.public_profile",
            ownerProgress: "in_progress",
            readiness: "rejected",
            actionableBy: "owner",
            reasonCodes: ["marketplace_profile_rejected"],
          }),
          task({
            taskId: "creator_offer",
            track: "creator_marketplace",
            requirementOwnerDomain: "marketplace",
            destinationRouteKey: "marketplace.creator_offer",
            ownerProgress: "not_started",
            readiness: "blocked",
            actionableBy: null,
            reasonCodes: ["public_profile_incomplete"],
          }),
        ],
        recommendedTaskId: "public_profile",
        ownerProgress: { complete: 1, total: 3 },
        launchReadiness: {
          operationsUse: "not_applicable",
          directBookingPublish: "not_applicable",
          marketplacePublish: "blocked",
        },
      },
      updatedAt: evaluatedAt,
    };

    expect(isSetupTaskLaunchable(status.setupPlan!.tasks[1])).toBe(true);
    expect(parseAdaptiveHotelSetupStatus(status)).toEqual(status);

    const invalid = structuredClone(status);
    const sharedTask = invalid.setupPlan!.tasks[0]!;
    sharedTask.ownerProgress = "in_progress";
    sharedTask.readiness = "rejected";
    sharedTask.actionableBy = "operator";
    sharedTask.reasonCodes = ["shared_identity_rejected"];
    invalid.setupPlan!.ownerProgress.complete = 0;
    invalid.setupPlan!.recommendedTaskId = "shared_identity";

    expect(isSetupTaskLaunchable(sharedTask)).toBe(false);
    expect(parseAdaptiveHotelSetupStatus(invalid)).toBeNull();
  });
});
