import { parseBookingGuestPolicyRevision } from "@vayada/domain-booking";
import { describe, expect, it } from "vitest";

import {
  appliedReceipt,
  applicationHarness,
  choices,
  command,
  compositionFixture,
  organizationId,
  propertyId,
  revisionFixture,
} from "./bookingGuestPolicyTestFixtures.js";

describe("Booking guest-policy application", () => {
  it("returns an authorized replay before reading mutable owner evidence", async () => {
    const revision = revisionFixture();
    const harness = applicationHarness({ current: revision, replay: revision });

    await expect(harness.application.upsertGuestPolicy(command())).resolves.toEqual({
      ok: true,
      outcome: "idempotent_replay",
      revision,
    });
    expect(harness.ownerCalls()).toBe(0);
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it("server-previews structured disclosures and persists only the exact current bundle", async () => {
    const harness = applicationHarness();
    const preview = await harness.application.previewGuestPolicy({
      organizationId,
      propertyId,
      choices,
    });
    expect(preview).toEqual(compositionFixture());
    expect(preview.outcome).toBe("ready");
    if (preview.outcome !== "ready") return;

    const request = command({ expectedSourceFingerprint: preview.bundle.sourceFingerprint });
    await expect(harness.application.upsertGuestPolicy(request)).resolves.toMatchObject({
      ok: true,
      outcome: "created",
      revision: { revision: 1, bundle: preview.bundle },
    });
    expect(harness.persist).toHaveBeenCalledWith({ ...request, bundle: preview.bundle });

    await expect(
      harness.application.upsertGuestPolicy({
        ...request,
        idempotencyKey: "stale-source",
        expectedSourceFingerprint: `sha256:${"0".repeat(64)}`,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "source_revision_conflict",
        currentSourceFingerprint: preview.bundle.sourceFingerprint,
      },
    });
  });

  it("serves first-visit defaults and fail-closed readiness, then becomes ready on live receipt evidence", async () => {
    const firstVisit = applicationHarness({ current: null });
    await expect(
      firstVisit.application.getGuestPolicySetup({ organizationId, propertyId }),
    ).resolves.toMatchObject({
      draft: {
        defaultGuestLanguage: null,
        childrenEnabled: null,
        phoneRequired: true,
        arrivalTimeEnabled: false,
        specialRequestsEnabled: true,
      },
      current: null,
      composition: null,
    });
    await expect(
      firstVisit.application.getGuestPolicyReadiness({ organizationId, propertyId }),
    ).resolves.toMatchObject({
      status: "blocked",
      guestPolicySourceRevision: "guest-policy:absent",
      blockers: [{ code: "guest_policy_not_configured", kind: "user_fixable" }],
    });

    const current = revisionFixture({ projectionReceipt: appliedReceipt() });
    const configured = applicationHarness({ current });
    await expect(
      configured.application.getGuestPolicyReadiness({ organizationId, propertyId }),
    ).resolves.toMatchObject({
      status: "ready",
      guestPolicySourceRevision: "guest-policy:1",
      sourceFingerprint: current.bundle.sourceFingerprint,
      currentBaseRevisions: {
        "booking.guest_experience": "guest-policy:1",
        "hotel_catalog.policy": `hotel_catalog.policy:${propertyId}:r9`,
      },
      blockers: [],
    });
  });

  it("keeps optional-only updates ready with a compatible inherited applied receipt", async () => {
    const previous = revisionFixture();
    const current = parseBookingGuestPolicyRevision({
      ...previous,
      revision: 2,
      bundle: {
        ...previous.bundle,
        choices: { ...previous.bundle.choices, phoneRequired: false },
      },
      projectionReceipt: appliedReceipt(),
    });
    if (!current) throw new Error("Expected valid optional-only fixture");

    await expect(
      applicationHarness({ current }).application.getGuestPolicyReadiness({
        organizationId,
        propertyId,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      guestPolicySourceRevision: "guest-policy:2",
      blockers: [],
    });
  });

  it("does not carry a source conflict across a later Booking revision", async () => {
    const previous = revisionFixture();
    const receipt = appliedReceipt();
    const current = parseBookingGuestPolicyRevision({
      ...previous,
      revision: 2,
      bundle: {
        ...previous.bundle,
        choices: { ...previous.bundle.choices, phoneRequired: false },
      },
      projectionReceipt: {
        outcome: "source_revision_conflict",
        receiptId: receipt.receiptId,
        sourceOutboxEventId: receipt.sourceOutboxEventId,
        projectedGuestPolicyRevision: receipt.projectedGuestPolicyRevision,
        projectedBundleHash: receipt.projectedBundleHash,
        projectedSourceFingerprint: receipt.projectedSourceFingerprint,
        catalogProfileSourceRevision: receipt.catalogProfileSourceRevision,
        observedCatalogProfileRevision: "profile:9",
        recordedAt: receipt.recordedAt,
      },
    });
    if (!current) throw new Error("Expected valid prior-conflict fixture");

    await expect(
      applicationHarness({ current }).application.getGuestPolicyReadiness({
        organizationId,
        propertyId,
      }),
    ).resolves.toMatchObject({
      status: "pending",
      blockers: [
        { code: "catalog_projection_stale", kind: "external_pending", owner: "hotel_catalog" },
      ],
    });
  });
});
