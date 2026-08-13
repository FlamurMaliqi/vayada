import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { AddOnListPicker } from "@/components/bookings/AddOnListPicker";
import type { PmsManualBookingPreviewResult } from "@/services/api/pmsManualBookingClient";
import { calendarService } from "@/services/calendar";
import TargetManualBookingModal from "./TargetManualBookingModal";

// prettier-ignore
const roomTypes = [{ id: "type-1", name: "Double", category: "", totalRooms: 1, baseRate: 100, maxOccupancy: 2, currency: "EUR", seasons: [], ratePlans: [{ id: "plan-1", name: "Flexible", rateType: "flexible" as const, baseRate: 100 }] }], rooms = [{ id: "room-1", roomTypeId: "type-1", roomTypeName: "Double", roomNumber: "101", floor: "1", status: "available" }], preview: PmsManualBookingPreviewResult = { contractVersion: "pms-manual-booking.v1", currency: "EUR", stays: [{ position: 1, roomId: "room-1", ratePlanId: "plan-1", nightly: [], standardTotal: { amountDecimal: "100.00", currency: "EUR" }, appliedTotal: { amountDecimal: "100.00", currency: "EUR" } }], addOns: [], grandTotal: { amountDecimal: "100.00", currency: "EUR" } };

// prettier-ignore
function render(canRecordPaidPayment = false) { return renderToStaticMarkup(createElement(TargetManualBookingModal, { roomTypes, rooms, canRecordPaidPayment, onSubmit: vi.fn(), onClose: vi.fn() })); }

describe("target manual booking fields", () => {
  it("offers only canonical direct sources and fixes the booking channel", () => {
    const markup = render();
    expect(markup).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-label="New booking"/);
    expect(markup).toMatch(/<input disabled=""[^>]*value="Direct"/);
    for (const source of ["Call", "Email", "WhatsApp", "Walk-in", "Social media", "Other"])
      expect(markup).toContain(` ${source} </option>`);
    for (const forbidden of ["Airbnb", "Booking.com", "Expedia", "Booking Engine"])
      expect(markup).not.toContain(forbidden);
  });

  it("separates notes, validates E.164, and fails Paid closed", () => {
    const markup = render();
    expect(markup).toContain('name="specialRequests"');
    expect(markup).toContain('name="privateNote"');
    expect(markup).toContain('name="phoneE164" type="tel" pattern="\\+[1-9][0-9]{7,14}"');
    expect(markup).toMatch(/disabled=""[^>]*value="paid"/);
    // prettier-ignore
    expect(markup).toMatch(/aria-describedby="paid-help"[^>]*>[\s\S]*Paid requires Finance write access/);
    expect(render(true)).not.toMatch(/disabled="" value="paid"/);
  });

  // prettier-ignore
  it("enables Paid from the selected property's protected capability", async () => { const capability = vi.spyOn(calendarService, "getManualBookingCapabilities").mockResolvedValue({ contractVersion: "pms-manual-booking.v1", canRecordPaidPayment: true }); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, onSubmit: vi.fn(), onClose: vi.fn() })); }); expect(view.root.findByProps({ value: "paid" }).props.disabled).toBe(false); capability.mockRestore(); });

  // prettier-ignore
  it("contains dialog focus and closes on Escape", async () => { const onClose = vi.fn(), first = { focus: vi.fn() }, last = { focus: vi.fn() }, panel = { focus: vi.fn(), querySelectorAll: () => [first, last] }, documentMock = { activeElement: last as unknown }; vi.stubGlobal("document", documentMock); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, onSubmit: vi.fn(), onClose }), { createNodeMock: (element) => element.props.role === "dialog" ? panel : null }); }); expect(panel.focus).toHaveBeenCalled(); const preventDefault = vi.fn(), dialog = view.root.findByProps({ role: "dialog" }); documentMock.activeElement = panel; act(() => dialog.props.onKeyDown({ key: "Tab", shiftKey: true, preventDefault })); expect(last.focus).toHaveBeenCalled(); documentMock.activeElement = last; act(() => dialog.props.onKeyDown({ key: "Tab", shiftKey: false, preventDefault })); expect(first.focus).toHaveBeenCalled(); act(() => dialog.props.onKeyDown({ key: "Escape" })); expect(onClose).toHaveBeenCalled(); act(() => view.unmount()); expect(last.focus).toHaveBeenCalled(); vi.unstubAllGlobals(); });

  it("explains invalid combined occupancy", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockResolvedValue(preview);
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit: vi.fn(), onClose: vi.fn() })); });
    const numberInputs = () =>
      view.root.findAllByType("input").filter((input) => input.props.type === "number");
    act(() => numberInputs()[0]!.props.onChange({ target: { value: "2" } }));
    act(() => numberInputs()[1]!.props.onChange({ target: { value: "1" } }));
    expect(view.root.findByProps({ id: "occupancy-error" }).children.join("")).toContain(
      "at most 2 guests",
    );
    // prettier-ignore
    expect(numberInputs().slice(0, 2).every((input) => input.props["aria-invalid"])).toBe(true);
  });

  it("locks an ambiguous create and retries the identical request", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockResolvedValue(preview);
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_, fail) => (reject = fail));
    const onSubmit = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({});
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit, onClose: vi.fn() })); });
    let submission!: Promise<void>;
    // prettier-ignore
    act(() => { submission = view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }); });
    expect(view.root.findByType("fieldset").props.disabled).toBe(true);
    // prettier-ignore
    await act(async () => { reject(new Error("Network lost.")); await submission; });
    expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain("safely resend");
    // prettier-ignore
    await act(async () => { await view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }); });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1]![0]).toEqual(onSubmit.mock.calls[0]![0]);
  });

  it("uses the primary action token for the add-on Done button", () => {
    const markup = renderToStaticMarkup(
      createElement(AddOnListPicker, {
        // prettier-ignore
        addons: [{ id: "addon", name: "Breakfast", description: "", price: 10, currency: "EUR", category: "meal" }],
        selectedIds: [],
        quantities: {},
        currency: "EUR",
        nights: 1,
        adults: 1,
        onChange: vi.fn(),
        onDone: vi.fn(),
      }),
    );
    expect(markup).toMatch(/<button[^>]*bg-primary-600[^>]*>Done<\/button>/);
  });
});
