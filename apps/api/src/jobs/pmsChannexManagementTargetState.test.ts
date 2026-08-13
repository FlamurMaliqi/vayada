import { describe, expect, it } from "vitest";

import type { ChannexManagementJob } from "./pmsChannexManagementWorker.js";
import { createPmsChannexManagementTargetState } from "./pmsChannexManagementTargetState.js";

const now = new Date("2026-08-13T10:00:00.000Z");

describe("PMS Channex management target state", () => {
  it.each([
    ["enable", "INSERT INTO pms.channel_connections"],
    ["disable", "UPDATE pms.channel_connections SET connection_status = 'disconnected'"],
    ["sync_ari", "pms.channel_sync_status"],
    ["sync_bookings", "pms.channel_sync_status"],
    ["install_messaging", "messaging_app_installed"],
  ] as const)("applies %s only to target PMS state", async (operationType, expectedSql) => {
    const client = fakeClient();
    await createPmsChannexManagementTargetState().succeed(
      client,
      job(operationType),
      { ok: true, externalPropertyId: "channex-1" },
      now,
    );
    expect(client.sql()).toContain(expectedSql);
    expect(client.sql()).not.toMatch(/webhook|callback|legacy/i);
  });

  it("persists provider-confirmed mappings, markups, and failure health", async () => {
    const client = fakeClient();
    const state = createPmsChannexManagementTargetState();
    await state.succeed(
      client,
      job("provision"),
      {
        ok: true,
        roomTypeMappings: [
          {
            mappingId: "m1",
            roomTypeId: "r1",
            roomTypeName: "Room",
            externalRoomTypeId: "er1",
            status: "active",
          },
        ],
        ratePlanMappings: [
          {
            mappingId: "m2",
            roomTypeId: "r1",
            ratePlanId: "p1",
            ratePlanName: "Plan",
            channel: "airbnb",
            externalRoomTypeId: "er1",
            externalRatePlanId: "ep1",
            sellMode: "per_room",
            markupPercent: 10,
            status: "active",
          },
        ],
      },
      now,
    );
    await state.succeed(
      client,
      {
        ...job("update_markups"),
        input: {
          ...job("update_markups").input,
          markups: [{ channel: "airbnb", markupPercent: 12 }],
        },
      },
      { ok: true },
      now,
    );
    await state.fail(
      client,
      job("sync_ari"),
      { ok: false, code: "timeout", message: "timed out" },
      { now, retryAt: null },
    );
    expect(client.sql()).toContain("pms.channel_room_type_mappings");
    expect(client.sql()).toContain("pms.channel_rate_plan_mappings");
    expect(client.sql()).toContain("AND connection_id = (");
    expect(client.sql()).toContain("last_error_code");
  });

  it("preserves connected channels when connection recovery has no channel snapshot", async () => {
    const client = fakeClient();

    await createPmsChannexManagementTargetState().succeed(
      client,
      job("enable"),
      { ok: true, externalPropertyId: "channex-1", connectionStatus: "connected" },
      now,
    );

    expect(client.sql()).not.toContain("connectedChannels");
  });

  it("clears channel state and disables mappings after provider disconnect", async () => {
    const client = fakeClient();

    await createPmsChannexManagementTargetState().succeed(
      client,
      job("disable"),
      { ok: true, connectionStatus: "disconnected" },
      now,
    );

    expect(client.sql()).toContain("messaging_app_installed = FALSE");
    expect(client.sql()).toContain("connection_metadata - 'connectedChannels'");
    expect(client.sql()).toContain("pms.channel_room_type_mappings SET status = 'disabled'");
    expect(client.sql()).toContain("pms.channel_rate_plan_mappings SET status = 'disabled'");
  });
});

function fakeClient() {
  const calls: string[] = [];
  return {
    query: async <T>(text: string) => {
      calls.push(text);
      return { rows: [] as T[] };
    },
    release() {},
    sql: () => calls.join("\n"),
  };
}

function job(operationType: ChannexManagementJob["input"]["operationType"]): ChannexManagementJob {
  return {
    jobId: "job-1",
    propertyId: "property-1",
    correlationId: null,
    attemptNumber: 1,
    maxAttempts: 5,
    input: { commandId: "command-1", idempotencyKey: "key-1", operationType },
  };
}
