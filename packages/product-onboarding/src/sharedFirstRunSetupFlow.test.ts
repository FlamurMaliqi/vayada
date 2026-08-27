import type {
  AdaptiveHotelSetupStatus,
  SetupTask,
  SetupTaskId,
  SetupTrack,
} from "@vayada/domain-hotels";
import { describe, expect, it } from "vitest";

import {
  isSetupTaskActionable,
  resolveSharedFirstRunSetupView,
  toggleSetupTrackSelection,
} from "./sharedFirstRunSetupFlow";

describe("resolveSharedFirstRunSetupView", () => {
  it("shows track selection first and does not infer a track from the entry product", () => {
    const status = statusFor([], []);
    status.propertySelection = {
      state: "no_property",
      selectedPropertyId: null,
      availableProperties: [],
    };
    status.setupPlan = null;
    status.entryDecision = {
      requestedProduct: "booking",
      propertyId: null,
      decision: "setup_required",
      destinationRouteKey: "hotel_setup",
      reasonCode: "track_not_selected",
    };

    expect(resolveSharedFirstRunSetupView(status)).toMatchObject({
      screen: "track_selection",
      profileMode: null,
    });
    expect(status.organization.selectedTracks).toEqual([]);
  });

  it.each([
    {
      name: "Hotel Operations",
      tracks: ["hotel_operations"] as SetupTrack[],
      tasks: [
        "shared_identity",
        "rooms_rates_availability",
        "guest_settings_policies",
        "billing_plan",
        "payment",
        "direct_booking_publication",
      ] as SetupTaskId[],
    },
    {
      name: "Creator Marketplace",
      tracks: ["creator_marketplace"] as SetupTrack[],
      tasks: ["shared_identity", "public_profile", "creator_offer"] as SetupTaskId[],
    },
    {
      name: "both tracks",
      tracks: ["hotel_operations", "creator_marketplace"] as SetupTrack[],
      tasks: [
        "shared_identity",
        "public_profile",
        "creator_offer",
        "rooms_rates_availability",
        "guest_settings_policies",
        "billing_plan",
        "payment",
        "direct_booking_publication",
      ] as SetupTaskId[],
    },
  ])("keeps the authoritative $name task plan", ({ tracks, tasks }) => {
    const view = resolveSharedFirstRunSetupView(statusFor(tracks, tasks));

    expect(view.screen).toBe("setup_plan");
    expect(view.setupPlan?.tasks.map(({ taskId }) => taskId)).toEqual(tasks);
  });

  it("reopens the selected property's existing profile inside setup when hotel basics are edited", () => {
    const status = statusFor(
      ["creator_marketplace"],
      ["shared_identity", "public_profile", "creator_offer"],
    );

    expect(resolveSharedFirstRunSetupView(status, { editPropertyProfile: true })).toMatchObject({
      screen: "property_profile",
      profileMode: "update",
      selectedPropertyId: "property-1",
      title: "Hotel Alpenrose",
    });
  });
});

describe("toggleSetupTrackSelection", () => {
  it("locks existing tracks while allowing another track to be added", () => {
    expect(
      toggleSetupTrackSelection(["hotel_operations"], ["hotel_operations"], "hotel_operations"),
    ).toEqual(["hotel_operations"]);
    expect(
      toggleSetupTrackSelection(["hotel_operations"], ["hotel_operations"], "creator_marketplace"),
    ).toEqual(["hotel_operations", "creator_marketplace"]);
  });
});

describe("isSetupTaskActionable", () => {
  it("lets an owner reopen rejected Marketplace work for correction", () => {
    expect(
      isSetupTaskActionable({
        track: "creator_marketplace",
        readiness: "rejected",
        callerCapability: "allowed",
      }),
    ).toBe(true);
  });

  it("does not make rejected Operations work or denied tasks launchable", () => {
    expect(
      isSetupTaskActionable({
        track: "hotel_operations",
        readiness: "rejected",
        callerCapability: "allowed",
      }),
    ).toBe(false);
    expect(
      isSetupTaskActionable({
        track: "creator_marketplace",
        readiness: "rejected",
        callerCapability: "forbidden",
      }),
    ).toBe(false);
  });
});

function statusFor(selectedTracks: SetupTrack[], taskIds: SetupTaskId[]): AdaptiveHotelSetupStatus {
  const tasks = taskIds.map(setupTask);
  return {
    contractVersion: "adaptive-hotel-setup.v1",
    organization: {
      organizationId: "organization-1",
      displayName: "Alpenrose Group",
      websiteUrl: null,
      selectedTracks,
      trackRevision: 1,
      canManageTracks: true,
      tracks: [
        {
          track: "hotel_operations",
          provisioning: selectedTracks.includes("hotel_operations") ? "active" : "not_selected",
          components: [
            { product: "pms", access: "active" },
            { product: "booking", access: "active" },
          ],
          allowedActions: [],
        },
        {
          track: "creator_marketplace",
          provisioning: selectedTracks.includes("creator_marketplace") ? "active" : "not_selected",
          components: [{ product: "marketplace", access: "active" }],
          allowedActions: [],
        },
      ],
    },
    propertySelection: {
      state: "single_property",
      selectedPropertyId: "property-1",
      availableProperties: [
        {
          propertyId: "property-1",
          publicId: "hotel-alpenrose",
          displayName: "Hotel Alpenrose",
          locationSummary: "Munich, Germany",
        },
      ],
    },
    entryDecision: null,
    setupPlan: {
      propertyId: "property-1",
      planRevision: "plan-1",
      tasks,
      recommendedTaskId:
        tasks.find(
          ({ readiness, callerCapability }) =>
            readiness === "actionable" && callerCapability === "allowed",
        )?.taskId ?? null,
      ownerProgress: {
        complete: tasks.filter(({ ownerProgress }) => ownerProgress === "owner_complete").length,
        total: tasks.length,
      },
      launchReadiness: {
        operationsUse: selectedTracks.includes("hotel_operations") ? "pending" : "not_applicable",
        directBookingPublish: selectedTracks.includes("hotel_operations")
          ? "pending"
          : "not_applicable",
        marketplacePublish: selectedTracks.includes("creator_marketplace")
          ? "pending"
          : "not_applicable",
      },
    },
    updatedAt: "2026-07-26T12:00:00.000Z",
  };
}

function setupTask(taskId: SetupTaskId): SetupTask {
  const complete = taskId === "shared_identity";
  const track =
    taskId === "shared_identity"
      ? "shared"
      : ["public_profile", "creator_offer"].includes(taskId)
        ? "creator_marketplace"
        : "hotel_operations";
  return {
    taskId,
    propertyId: "property-1",
    track,
    requirementOwnerDomain: "hotel_catalog",
    destinationRouteKey: `setup.${taskId}`,
    callerCapability: "allowed",
    ownerProgress: complete ? "owner_complete" : "not_started",
    readiness: complete ? "complete" : "actionable",
    actionableBy: complete ? null : "owner",
    reasonCodes: [],
    sourceRevision: "revision-1",
    freshness: "fresh",
    evaluatedAt: "2026-07-26T12:00:00.000Z",
  };
}
