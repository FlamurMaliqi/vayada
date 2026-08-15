import {
  hashSourceManifest,
  type ReadyProductReadinessEvidence,
  type SourceManifest,
  type SourceManifestHash,
} from "@vayada/domain-hotels";

import {
  buildPublicBookabilityProfileProjection,
  type PublicBookabilityProducerInputs,
} from "./index.js";
import { buildBookingPublicContent, type BookingPublicContentBuild } from "./bookingPublication.js";
import {
  bookingPublicationOwnerSnapshotProvenanceMatches,
  type BookingPublicationOwnerSnapshot,
  type BookingPublicationOwnerSnapshotPort,
  type BookingPublicationSnapshotContent,
  type BookingPublicationSnapshotRequest,
} from "./bookingPublicationOwnerSnapshots.js";

export type BookingPublicationBuildResult =
  | Readonly<{ outcome: "built"; build: BookingPublicContentBuild }>
  | Readonly<{
      outcome: "rejected";
      code: "owner_snapshot_unavailable" | "source_manifest_mismatch" | "public_content_incomplete";
    }>;

export type BookingPublicationBuilderPort = Readonly<{
  build(
    input: Readonly<{
      organizationId: string;
      readiness: ReadyProductReadinessEvidence<"booking">;
      generatedAt: string;
    }>,
  ): Promise<BookingPublicationBuildResult>;
}>;

export function createBookingPublicationBuilder(config: {
  catalog: BookingPublicationOwnerSnapshotPort<"hotel_catalog">;
  booking: BookingPublicationOwnerSnapshotPort<"booking">;
  pms: BookingPublicationOwnerSnapshotPort<"pms">;
  finance: BookingPublicationOwnerSnapshotPort<"finance">;
  bookingWeb(
    input: Readonly<{ propertyId: string; slug: string }>,
  ): PublicBookabilityProducerInputs["bookingWeb"];
}): BookingPublicationBuilderPort {
  return {
    async build(input) {
      const { readiness } = input;
      if (
        !input.organizationId.trim() ||
        readiness.product !== "booking" ||
        readiness.status !== "ready" ||
        readiness.propertyId !== readiness.sourceManifest.propertyId ||
        (await safeManifestHash(readiness.sourceManifest)) !== readiness.sourceManifestHash
      ) {
        return rejected("source_manifest_mismatch");
      }
      const request = deepFreeze({
        organizationId: input.organizationId,
        propertyId: readiness.propertyId,
        sourceManifest: structuredClone(readiness.sourceManifest),
        sourceManifestHash: readiness.sourceManifestHash,
      });
      let snapshots: readonly unknown[];
      try {
        snapshots = await Promise.all([
          config.catalog.getSnapshot(request),
          config.booking.getSnapshot(request),
          config.pms.getSnapshot(request),
          config.finance.getSnapshot(request),
        ]);
      } catch {
        return rejected("owner_snapshot_unavailable");
      }
      if (snapshots.some((snapshot) => !isRecord(snapshot) || snapshot["outcome"] !== "snapshot")) {
        return rejected("owner_snapshot_unavailable");
      }
      const [catalog, booking, pms, finance] = snapshots as [
        BookingPublicationOwnerSnapshot<"hotel_catalog">,
        BookingPublicationOwnerSnapshot<"booking">,
        BookingPublicationOwnerSnapshot<"pms">,
        BookingPublicationOwnerSnapshot<"finance">,
      ];
      if (
        !bookingPublicationOwnerSnapshotProvenanceMatches(catalog, "hotel_catalog", request) ||
        !bookingPublicationOwnerSnapshotProvenanceMatches(booking, "booking", request) ||
        !bookingPublicationOwnerSnapshotProvenanceMatches(pms, "pms", request) ||
        !bookingPublicationOwnerSnapshotProvenanceMatches(finance, "finance", request) ||
        catalog.content.propertyId !== request.propertyId
      ) {
        return rejected("source_manifest_mismatch");
      }
      try {
        const bookingWeb = config.bookingWeb({
          propertyId: request.propertyId,
          slug: catalog.content.slug,
        });
        if (!validBookingWeb(bookingWeb)) return rejected("public_content_incomplete");
        const profile = buildPublicBookabilityProfileProjection(input.generatedAt, {
          hotelCatalog: catalog.content,
          booking: sanitizeBooking(booking.content),
          pms: pms.content,
          finance: finance.content,
          bookingWeb,
        });
        const build = buildBookingPublicContent({
          sourceManifestHash: readiness.sourceManifestHash,
          readinessHash: readiness.readinessHash,
          profile,
          rooms: pms.content.rooms,
          calendar: pms.content.calendar,
          finance: finance.content,
        });
        return build
          ? deepFreeze({ outcome: "built", build })
          : rejected("public_content_incomplete");
      } catch {
        return rejected("public_content_incomplete");
      }
    },
  };
}

function validBookingWeb(value: PublicBookabilityProducerInputs["bookingWeb"]): boolean {
  try {
    const canonical = new URL(value.canonicalUrl);
    const booking = new URL(value.bookingBaseUrl);
    const custom = value.customDomainUrl ? new URL(value.customDomainUrl) : null;
    return (
      canonical.protocol === "https:" &&
      booking.protocol === "https:" &&
      !canonical.username &&
      !canonical.password &&
      cleanOriginUrl(booking) &&
      canonical.origin === booking.origin &&
      value.bookingDeepLinks &&
      (custom
        ? value.domainVerified && cleanOriginUrl(custom) && custom.origin === booking.origin
        : !value.domainVerified)
    );
  } catch {
    return false;
  }
}

const cleanOriginUrl = (value: URL) =>
  value.protocol === "https:" &&
  !value.username &&
  !value.password &&
  value.pathname === "/" &&
  !value.search &&
  !value.hash;

function sanitizeBooking(
  content: BookingPublicationSnapshotContent["booking"],
): BookingPublicationSnapshotContent["booking"] {
  const branding = content.branding;
  return {
    ...content,
    ...(branding
      ? {
          branding: {
            logoUrl: branding.logoUrl,
            heroImage: branding.heroImage,
            heroHeading: branding.heroHeading,
            heroSubtext: branding.heroSubtext,
            primaryColor: branding.primaryColor,
            fontPairing: branding.fontPairing,
          },
        }
      : { branding: undefined }),
  };
}

async function safeManifestHash(manifest: SourceManifest): Promise<SourceManifestHash | null> {
  try {
    return await hashSourceManifest(manifest);
  } catch {
    return null;
  }
}

function rejected(code: Extract<BookingPublicationBuildResult, { outcome: "rejected" }>["code"]) {
  return Object.freeze({ outcome: "rejected" as const, code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
