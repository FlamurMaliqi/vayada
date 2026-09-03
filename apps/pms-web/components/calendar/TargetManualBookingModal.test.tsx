import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddOnListPicker } from "@/components/bookings/AddOnListPicker";
// prettier-ignore
import { PmsManualBookingServiceError, type PmsManualBookingPreviewInput, type PmsManualBookingPreviewResult } from "@/services/api/pmsManualBookingClient";
import { calendarService } from "@/services/calendar";
import TargetManualBookingModal from "./TargetManualBookingModal";

// prettier-ignore
const roomTypes = [{ id: "type-1", name: "Double", category: "", totalRooms: 1, baseRate: 100, maxOccupancy: 2, currency: "EUR", seasons: [], ratePlans: [{ id: "plan-1", name: "Flexible", rateType: "flexible" as const, baseRate: 100 }] }, { id: "type-2", name: "Villa", category: "", totalRooms: 1, baseRate: 200, maxOccupancy: 5, currency: "EUR", seasons: [], ratePlans: [{ id: "plan-2", name: "Villa flexible", rateType: "flexible" as const, baseRate: 200 }] }], rooms = [{ id: "room-1", roomTypeId: "type-1", roomTypeName: "Double", roomNumber: "101", floor: "1", status: "available", baseRate: 100, currency: "EUR", maxOccupancy: 2, size: 20 }, { id: "room-2", roomTypeId: "type-2", roomTypeName: "Villa", roomNumber: "V1", floor: "1", status: "available", baseRate: 200, currency: "EUR", maxOccupancy: 5, size: 80 }], preview: PmsManualBookingPreviewResult = { contractVersion: "pms-manual-booking.v1", currency: "EUR", stays: [{ position: 1, roomId: "room-1", ratePlanId: "plan-1", nightly: [{ serviceDate: "2026-09-10", standard: { amountDecimal: "100.00", currency: "EUR" }, applied: { amountDecimal: "100.00", currency: "EUR" } }], standardTotal: { amountDecimal: "100.00", currency: "EUR" }, appliedTotal: { amountDecimal: "100.00", currency: "EUR" } }], addOns: [], grandTotal: { amountDecimal: "100.00", currency: "EUR" } };

// prettier-ignore
function previewFor(input: PmsManualBookingPreviewInput): PmsManualBookingPreviewResult { const stays = input.stays.map((stay) => ({ ...preview.stays[0]!, position: stay.position, roomId: stay.roomId, ratePlanId: stay.ratePlanId })), addOns = input.addOns.map((addon) => ({ ...addon, pricingModel: "per_guest_night" as const, unitPrice: { amountDecimal: "10.00", currency: "EUR" }, total: { amountDecimal: "20.00", currency: "EUR" } })); return { ...preview, stays, addOns, grandTotal: { amountDecimal: String(stays.length * 100 + addOns.length * 20), currency: "EUR" } }; }

// prettier-ignore
function render(canRecordPaidPayment = false) { return renderToStaticMarkup(createElement(TargetManualBookingModal, { roomTypes, rooms, canRecordPaidPayment, onSubmit: vi.fn(), onClose: vi.fn() })); }

async function settlePreview() {
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
}

describe("target manual booking fields", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(calendarService, "listAvailableAddons").mockResolvedValue([]);
    vi.spyOn(calendarService, "getManualBookingCapabilities").mockResolvedValue({
      contractVersion: "pms-manual-booking.v1",
      canRecordPaidPayment: false,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
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
    expect(view.root.findByProps({ id: "stay-occupancy-1" }).children.join("")).toContain(
      "at most 2 guests",
    );
    // prettier-ignore
    expect(numberInputs().slice(0, 2).every((input) => input.props["aria-invalid"])).toBe(true);
  });

  // prettier-ignore
  it("submits independently priced heterogeneous stays in stable order", async () => { vi.spyOn(calendarService, "listAvailableAddons").mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000001", name: "Breakfast", description: "", price: 10, currency: "EUR", category: "meal", perPerson: true, perNight: true }]); vi.spyOn(calendarService, "previewManualBooking").mockImplementation(async (input) => previewFor(input)); const onSubmit = vi.fn().mockResolvedValue({}); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit, onClose: vi.fn() })); }); const button = (label: string) => view.root.findAllByType("button").find((item) => item.children.join("") === label)!, input = (label: string) => view.root.findByProps({ "aria-label": label }); await act(async () => button("+ Add another room").props.onClick()); await act(async () => input("Room 2 check-in").props.onChange({ target: { value: "2026-09-12" } })); await act(async () => input("Room 2 check-out").props.onChange({ target: { value: "2026-09-15" } })); await act(async () => input("Room 2 adults").props.onChange({ target: { value: "3" } })); await act(async () => input("Room 2 nightly rate").props.onChange({ target: { value: "275.50" } })); await act(async () => view.root.findAllByType("input").find((item) => item.props.type === "checkbox")!.props.onChange({ target: { checked: true } })); await settlePreview(); await act(async () => { await view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }); }); expect(onSubmit.mock.calls[0]![0].stays).toMatchObject([{ position: 1, roomId: "room-1", checkIn: "2026-09-10", adults: 1, ratePlanId: "plan-1" }, { position: 2, roomId: "room-2", checkIn: "2026-09-12", checkOut: "2026-09-15", adults: 3, ratePlanId: "plan-2", pricing: { kind: "rate_plan", manualOverride: { amountDecimal: "275.50", currency: "EUR" } } }]); expect(onSubmit.mock.calls[0]![0].addOns).toEqual([{ addonId: "00000000-0000-4000-8000-000000000001", packageCount: 1, serviceUnits: [{ serviceDate: "2026-09-10", guestCount: 1 }, { serviceDate: "2026-09-12", guestCount: 3 }, { serviceDate: "2026-09-13", guestCount: 3 }, { serviceDate: "2026-09-14", guestCount: 3 }] }]); expect(JSON.stringify(view.toJSON())).toContain("€20"); });

  it("blocks overlapping reuse, then removes and renumbers stays", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockImplementation(async (input) =>
      previewFor(input),
    );
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-12", onSubmit: vi.fn(), onClose: vi.fn() })); });
    const add = () =>
      view.root
        .findAllByType("button")
        .find((item) => item.children.join("") === "+ Add another room")!;
    expect(
      view.root
        .findAllByType("button")
        .some((item) => item.props["aria-label"]?.startsWith("Remove room")),
    ).toBe(false);
    await act(async () => add().props.onClick());
    act(() =>
      view.root
        .findByProps({ "aria-label": "Room 2 room" })
        .props.onChange({ target: { value: "room-1" } }),
    );
    expect(
      view.root
        .findAllByProps({ role: "alert" })
        .some((item) => item.children.join("").includes("overlaps another stay")),
    ).toBe(true);
    expect(view.root.findAllByProps({ "data-stay": true })).toHaveLength(2);
    act(() => view.root.findByProps({ "aria-label": "Remove room 1" }).props.onClick());
    expect(view.root.findAllByProps({ "data-stay": true })).toHaveLength(1);
    expect(view.root.findByProps({ "aria-label": "Room 1 room" }).props.value).toBe("room-1");
    for (let count = 1; count < 20; count += 1) act(() => add().props.onClick());
    expect(view.root.findAllByProps({ "data-stay": true })).toHaveLength(20);
    expect(add().props.disabled).toBe(true);
  });

  // prettier-ignore
  it("places and focuses a server stay error inside its room card", async () => { const focus = vi.fn(), error = new PmsManualBookingServiceError("conflict", "room_unavailable", 409, "Room is no longer available.", "roomId", 2); vi.spyOn(calendarService, "previewManualBooking").mockImplementation(async (input) => { if (input.stays.length > 1) throw error; return previewFor(input); }); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit: vi.fn(), onClose: vi.fn() }), { createNodeMock: (element) => element.props["aria-label"]?.endsWith(" room") ? { focus } : element.props.role === "dialog" ? { focus: vi.fn(), querySelectorAll: () => [] } : null }); }); await act(async () => view.root.findAllByType("button").find((item) => item.children.join("") === "+ Add another room")!.props.onClick()); await settlePreview(); expect(view.root.findByProps({ "aria-label": "Room 2 room" }).props["aria-invalid"]).toBe(true); expect(view.root.findAllByProps({ "data-stay": true })[1]!.findByProps({ role: "alert" }).children.join("")).toContain("no longer available"); expect(focus).toHaveBeenCalledTimes(2); });

  // prettier-ignore
  it("places and focuses a positioned server date error on check-in", async () => { const focus = vi.fn(), error = new PmsManualBookingServiceError("validation", "invalid_dates", 422, "Stay dates are invalid.", "stays", 2); vi.spyOn(calendarService, "previewManualBooking").mockImplementation(async (input) => { if (input.stays.length > 1) throw error; return previewFor(input); }); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit: vi.fn(), onClose: vi.fn() }), { createNodeMock: (element) => element.props["aria-label"]?.endsWith(" check-in") ? { focus } : element.props.role === "dialog" ? { focus: vi.fn(), querySelectorAll: () => [] } : null }); }); await act(async () => view.root.findAllByType("button").find((item) => item.children.join("") === "+ Add another room")!.props.onClick()); await settlePreview(); const checkIn = view.root.findByProps({ "aria-label": "Room 2 check-in" }); expect(checkIn.props["aria-invalid"]).toBe(true); expect(checkIn.props["aria-describedby"]).toBe("stay-server-2"); expect(focus).toHaveBeenCalledOnce(); });

  it("coalesces rapid room, date, rate, and add-on edits into one preview", async () => {
    vi.spyOn(calendarService, "listAvailableAddons").mockResolvedValue([
      {
        id: "addon-1",
        name: "Breakfast",
        description: "",
        price: 10,
        currency: "EUR",
        category: "meal",
        perPerson: true,
        perNight: true,
      },
    ]);
    const request = vi
      .spyOn(calendarService, "previewManualBooking")
      .mockImplementation(async (input) => previewFor(input));
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes,
          rooms,
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          canRecordPaidPayment: false,
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    const input = (label: string) => view.root.findByProps({ "aria-label": label });
    act(() => input("Room 1 room").props.onChange({ target: { value: "room-2" } }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => input("Room 1 check-in").props.onChange({ target: { value: "2026-09-12" } }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => input("Room 1 check-out").props.onChange({ target: { value: "2026-09-15" } }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => input("Room 1 nightly rate").props.onChange({ target: { value: "275.50" } }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() =>
      view.root
        .findAllByType("input")
        .find((item) => item.props.type === "checkbox")!
        .props.onChange({ target: { checked: true } }),
    );

    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      stays: [
        expect.objectContaining({
          roomId: "room-2",
          checkIn: "2026-09-12",
          checkOut: "2026-09-15",
          ratePlanId: "plan-2",
          pricing: {
            kind: "rate_plan",
            manualOverride: { amountDecimal: "275.50", currency: "EUR" },
          },
        }),
      ],
      addOns: [expect.objectContaining({ addonId: "addon-1", packageCount: 1 })],
    });
  });

  it("keeps the latest evidence when an older preview resolves last", async () => {
    const pending: Array<{
      input: PmsManualBookingPreviewInput;
      resolve: (result: PmsManualBookingPreviewResult) => void;
    }> = [];
    vi.spyOn(calendarService, "previewManualBooking").mockImplementation(
      (input) => new Promise((resolve) => pending.push({ input, resolve })),
    );
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes,
          rooms,
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          canRecordPaidPayment: false,
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await settlePreview();
    act(() =>
      view.root
        .findByProps({ "aria-label": "Room 1 nightly rate" })
        .props.onChange({ target: { value: "150" } }),
    );
    await settlePreview();
    expect(pending).toHaveLength(2);

    await act(async () =>
      pending[1]!.resolve({
        ...previewFor(pending[1]!.input),
        grandTotal: { amountDecimal: "150.00", currency: "EUR" },
      }),
    );
    expect(JSON.stringify(view.toJSON())).toContain("Total €150");
    expect(view.root.findByProps({ form: "target-manual-booking" }).props.disabled).toBe(false);

    await act(async () => pending[0]!.resolve(previewFor(pending[0]!.input)));
    expect(JSON.stringify(view.toJSON())).toContain("Total €150");
    expect(JSON.stringify(view.toJSON())).not.toContain("Total €100");
  });

  it("shows a spinner only when pricing takes longer than one second", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockReturnValue(new Promise(() => undefined));
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes,
          rooms,
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(view.root.findAllByProps({ "data-pricing-spinner": true })).toHaveLength(0);
    expect(view.root.findByProps({ form: "target-manual-booking" }).props.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(view.root.findAllByProps({ "data-pricing-spinner": true })).toHaveLength(1);
    expect(JSON.stringify(view.toJSON())).toContain("Calculating total");
    act(() => view.unmount());
  });

  it("offers retry with the pricing failure guidance", async () => {
    const request = vi
      .spyOn(calendarService, "previewManualBooking")
      .mockRejectedValue(new Error("Preview is unavailable."));
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes,
          rooms,
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await settlePreview();

    expect(JSON.stringify(view.toJSON())).toContain(
      "Couldn't calculate pricing. Check that this room type has rates set up for the selected dates, then try again.",
    );
    const retry = view.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Retry pricing")!;
    await act(async () => retry.props.onClick());
    await settlePreview();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("explains a missing rate for the selected dates and keeps creation blocked", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockRejectedValue(
      new PmsManualBookingServiceError(
        "not_found",
        "rate_plan_not_found",
        404,
        "rate plan not found.",
        "ratePlanId",
        1,
      ),
    );
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes,
          rooms,
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await settlePreview();

    expect(JSON.stringify(view.toJSON())).toContain(
      "No rate found for 2026-09-10 – 2026-09-11. Set up a season in Rooms & Rates first.",
    );
    expect(
      view.root
        .findAllByType("button")
        .some((button) => button.children.join("") === "Retry pricing"),
    ).toBe(false);
    expect(view.root.findByProps({ form: "target-manual-booking" }).props.disabled).toBe(true);
  });

  it("shows missing-rate guidance before preview when the room type has no rate plan", async () => {
    const request = vi.spyOn(calendarService, "previewManualBooking");
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes: [{ ...roomTypes[0]!, ratePlans: [] }],
          rooms: [rooms[0]!],
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await settlePreview();

    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(view.toJSON())).toContain(
      "No rate found for 2026-09-10 – 2026-09-11. Set up a season in Rooms & Rates first.",
    );
    expect(view.root.findByProps({ form: "target-manual-booking" }).props.disabled).toBe(true);
  });

  // prettier-ignore
  it("cannot create from stale evidence after the current preview fails", async () => { let fail = false; const onSubmit = vi.fn(); vi.spyOn(calendarService, "previewManualBooking").mockImplementation(async (input) => { if (fail) throw new Error("Preview failed."); return previewFor(input); }); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit, onClose: vi.fn() })); }); await settlePreview(); const adults = view.root.findByProps({ "aria-label": "Room 1 adults" }); fail = true; act(() => adults.props.onChange({ target: { value: "3" } })); await act(async () => view.root.findByProps({ "aria-label": "Room 1 adults" }).props.onChange({ target: { value: "1" } })); await settlePreview(); expect(JSON.stringify(view.toJSON())).toContain("Couldn't calculate pricing."); expect(view.root.findByProps({ form: "target-manual-booking" }).props.disabled).toBe(true); await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() })); expect(onSubmit).not.toHaveBeenCalled(); });

  it("locks an ambiguous create and retries the identical request", async () => {
    let resolveAddons!: (addons: []) => void;
    vi.spyOn(calendarService, "listAvailableAddons").mockReturnValue(
      new Promise((resolve) => (resolveAddons = resolve)),
    );
    vi.spyOn(calendarService, "previewManualBooking")
      .mockResolvedValueOnce(preview)
      .mockRejectedValue(new Error("Room changed."));
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_, fail) => (reject = fail));
    const onSubmit = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({});
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit, onClose: vi.fn() })); });
    await settlePreview();
    let submission!: Promise<void>;
    // prettier-ignore
    act(() => { submission = view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }); });
    expect(view.root.findByType("fieldset").props.disabled).toBe(true);
    // prettier-ignore
    await act(async () => resolveAddons([]));
    await act(async () => {
      reject(new Error("Network lost."));
      await submission;
    });
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
