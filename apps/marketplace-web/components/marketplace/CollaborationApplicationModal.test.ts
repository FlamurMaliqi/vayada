import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  submissionRef: { current: null as null | { fingerprint: string; keys: Record<string, string> } },
  resetDeliverables: vi.fn(),
  createKey: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useRef: () => mocks.submissionRef,
    useState: (initial: unknown) => {
      const index = mocks.stateSetters.length;
      const setter = vi.fn();
      mocks.stateSetters.push(setter);
      return [mocks.stateValues[index] ?? initial, setter];
    },
  };
});

vi.mock("@/hooks/usePlatformDeliverables", () => ({
  usePlatformDeliverables: () => ({
    platformDeliverables: [
      { platform: "Instagram", deliverables: [{ type: "Reel", quantity: 1 }] },
    ],
    customDeliverableInput: "",
    setCustomDeliverableInput: vi.fn(),
    handlePlatformToggle: vi.fn(),
    handleDeliverableQuantityChange: vi.fn(),
    handleAddCustomDeliverable: vi.fn(),
    handleRemoveCustomDeliverable: vi.fn(),
    isPlatformSelected: vi.fn(),
    getPlatformDeliverables: vi.fn(),
    resetDeliverables: mocks.resetDeliverables,
  }),
}));

vi.mock("@/services/api/collaborations", () => ({
  createCollaborationWriteIdempotencyKey: mocks.createKey,
}));

vi.mock("@/components/ui/useModalAccessibility", () => ({
  useModalAccessibility: vi.fn(),
}));

import {
  CollaborationApplicationModal,
  type CollaborationApplicationData,
  type CollaborationApplicationSubmissionOptions,
} from "./CollaborationApplicationModal";

type SubmitApplication = (
  data: CollaborationApplicationData,
  options: CollaborationApplicationSubmissionOptions,
) => Promise<void>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stateSetters.length = 0;
  mocks.stateValues = [
    "compensation-001",
    "My travel audience is a strong fit for this hotel.",
    "2099-09-01",
    "2099-09-03",
    [],
    true,
    false,
    null,
  ];
  mocks.submissionRef.current = null;
  mocks.createKey.mockReturnValue("marketplace.collaboration.create:offer-001:submission:v1");
});

describe("CollaborationApplicationModal submission", () => {
  it("awaits submission before resetting and closing", async () => {
    let resolveSubmission!: () => void;
    const onSubmit = vi.fn<SubmitApplication>(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmission = resolve;
        }),
    );
    const onClose = vi.fn<() => void>();
    const submit = renderSubmitHandler(onSubmit, onClose);

    const pending = submit();
    await Promise.resolve();

    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.resetDeliverables).not.toHaveBeenCalled();

    resolveSubmission();
    await pending;

    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.resetDeliverables).toHaveBeenCalledOnce();
  });

  it("keeps form state and reuses the submission key after a failed attempt", async () => {
    const onSubmit = vi
      .fn<SubmitApplication>()
      .mockRejectedValueOnce(new Error("Network request timed out"))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn<() => void>();
    const submit = renderSubmitHandler(onSubmit, onClose);

    await submit();

    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.resetDeliverables).not.toHaveBeenCalled();
    expect(mocks.stateSetters[1]).not.toHaveBeenCalled();
    expect(mocks.stateSetters[7]).toHaveBeenLastCalledWith("Network request timed out");

    await submit();

    expect(onSubmit.mock.calls[1]?.[1]).toEqual(onSubmit.mock.calls[0]?.[1]);
    expect(mocks.createKey).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

function renderSubmitHandler(onSubmit: SubmitApplication, onClose: () => void) {
  const tree = CollaborationApplicationModal({
    isOpen: true,
    listingId: "offer-001",
    propertyTimezone: "Europe/Berlin",
    onClose,
    onSubmit,
    creatorPlatforms: ["Instagram"],
    compensationOptions: [
      {
        id: "compensation-001",
        listing_id: "offer-001",
        collaboration_type: "Paid",
        availability_months: [],
        platforms: ["Instagram"],
        paid_max_amount: 500,
        currency: "EUR",
        created_at: "2026-07-21T08:00:00.000Z",
        updated_at: "2026-07-21T08:00:00.000Z",
      },
    ],
  });
  const button = findElement(tree, (element) => element.props.children === "Submit Application");
  return button.props.onClick as () => Promise<void>;
}

function findElement(
  node: unknown,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> {
  if (node && typeof node === "object" && "props" in node) {
    const element = node as ReactElement<Record<string, unknown>>;
    if (predicate(element)) return element;
    const children = element.props.children;
    for (const child of Array.isArray(children) ? children : [children]) {
      try {
        return findElement(child, predicate);
      } catch {}
    }
  }
  throw new Error("Element not found");
}
