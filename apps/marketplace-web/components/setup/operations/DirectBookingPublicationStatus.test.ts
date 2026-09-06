import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  getDirectBookingSetup: vi.fn(),
  saveDirectBookingSetup: vi.fn(),
  publishDirectBooking: vi.fn(),
  getDirectBookingPublication: vi.fn(),
}));
vi.mock("@/services/api/hotelOperationsSetupClient", async (original) => ({
  ...(await original<object>()),
  hotelOperationsSetupApi: api,
}));
vi.mock("@vayada/product-onboarding", async (original) => ({
  ...await original<object>(),
  BOOKING_PAGE_COLOR_PRESETS: [],
  BOOKING_PAGE_FONT_PAIRINGS: [],
  BrandMediaStep: (props: { notice: ReactNode; onContinue: () => void; continueLabel: string }) =>
    createElement(
      "section",
      {},
      props.notice,
      createElement("button", { onClick: props.onContinue }, props.continueLabel),
    ),
}));
import { DirectBookingPublicationForm } from "./DirectBookingPublicationForm";
it("checks the same pending canonical operation and completes only after success", async () => {
  api.getDirectBookingSetup.mockResolvedValue({
    propertyId: "property-1",
    propertyName: "Hotel One",
    heroImageUrl: "https://cdn.test/hero.webp",
    heroHeading: "Hotel One",
    heroSubtext: "Book with us.",
    primaryColor: "#2946E8",
    fontPairing: "modern-minimalist",
  });
  const operation = { operationId: "operation-1", propertyId: "property-1", status: "pending" };
  api.publishDirectBooking.mockResolvedValue(operation);
  api.getDirectBookingPublication.mockResolvedValue({ ...operation, status: "succeeded" });
  const onCompleted = vi.fn();
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(
      createElement(DirectBookingPublicationForm, {
        propertyId: "property-1",
        onBack: null,
        onBeforeSave: async () => {},
        onCompleted,
      }),
    );
  });
  await act(async () => view.root.findByType("button").props.onClick());
  expect(JSON.stringify(view.toJSON())).toContain("publication is in progress");
  expect(onCompleted).not.toHaveBeenCalled();
  await act(async () => view.root.findByType("button").props.onClick());
  expect(api.getDirectBookingPublication).toHaveBeenCalledWith("property-1", "operation-1");
  expect(api.publishDirectBooking).toHaveBeenCalledTimes(1);
  expect(onCompleted).toHaveBeenCalledTimes(1);
});
