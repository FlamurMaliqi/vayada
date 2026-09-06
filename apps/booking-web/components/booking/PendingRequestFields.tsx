"use client";
import { useTranslations } from "next-intl";
import {
  sameRoomSelection,
  selectionCheckoutFields,
  roomSelectionPartyMatches,
} from "@/lib/roomSelection";
import type { Addon, RoomType } from "@/lib/types";
import type { BookingCreateRequest, PaymentSettings } from "@/services/api/booking";
import type { PendingEditDetails } from "@/services/api/pendingBookingEdits";
const field = "mt-1 w-full rounded-lg border border-gray-300 bg-white p-3";
const button = "rounded-full bg-gray-900 px-6 py-3 font-semibold text-white disabled:opacity-50";
export default function PendingRequestFields({
  input,
  details,
  settings,
  rooms,
  addons,
  disabled,
  change,
}: {
  input: BookingCreateRequest;
  details: PendingEditDetails;
  settings: PaymentSettings | null;
  rooms: RoomType[];
  addons: Addon[];
  disabled: boolean;
  change: (patch: Partial<BookingCreateRequest>) => void;
}) {
  const t = useTranslations("roomSelection");
  const selected = rooms.find((room) =>
    input.roomSelection
      ? sameRoomSelection(room.combination?.roomSelection, input.roomSelection)
      : !room.combination && room.id === input.roomTypeId,
  );
  const original = input.roomSelection
    ? sameRoomSelection(input.roomSelection, details.input.roomSelection)
    : !details.input.roomSelection && input.roomTypeId === details.input.roomTypeId;
  const partyMatches =
    !input.roomSelection ||
    roomSelectionPartyMatches(input.roomSelection, input.adults, input.children);
  const methods = settings
    ? [
        ...(settings.payAtPropertyEnabled ? [["pay_at_property", "Pay at property"]] : []),
        ...(settings.onlineCardPayment ? [["card", "Card"]] : []),
        ...(settings.bankTransfer ? [["bank_transfer", "Bank transfer"]] : []),
        ...(settings.paypalEnabled ? [["paypal", "PayPal"]] : []),
      ]
    : [];

  return (
    <fieldset disabled={disabled} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          Check-in
          <input
            className={field}
            type="date"
            required
            value={input.checkIn}
            onChange={(e) => change({ checkIn: e.target.value })}
          />
        </label>
        <label>
          Check-out
          <input
            className={field}
            type="date"
            required
            min={input.checkIn}
            value={input.checkOut}
            onChange={(e) => change({ checkOut: e.target.value })}
          />
        </label>
        <label>
          Adults
          <input
            className={field}
            type="number"
            min={1}
            max={100}
            required
            value={input.adults}
            onChange={(e) => change({ adults: Number(e.target.value) })}
          />
        </label>
        <label>
          Children
          <input
            className={field}
            type="number"
            min={0}
            max={100}
            required
            value={input.children}
            onChange={(e) => change({ children: Number(e.target.value) })}
          />
        </label>
        <label>
          Room
          <select
            className={field}
            value={selected?.id ?? (original ? "original-selection" : "current-selection")}
            onChange={(e) => {
              if (e.target.value === "original-selection") {
                change({
                  roomTypeId: details.input.roomTypeId,
                  roomSelection: details.input.roomSelection,
                  numberOfRooms: details.input.numberOfRooms,
                  currency: details.input.currency,
                });
                return;
              }
              const room = rooms.find((candidate) => candidate.id === e.target.value);
              if (!room) return;
              change({
                ...selectionCheckoutFields(room),
                numberOfRooms: room.combination
                  ? room.combination.roomSelection.lines.reduce(
                      (sum, line) => sum + line.guests.length,
                      0,
                    )
                  : 1,
              });
            }}
          >
            <option value="original-selection">{details.booking.roomName}</option>
            {!selected && !original && (
              <option value="current-selection">{t("selectedAccommodation")}</option>
            )}
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Number of rooms
          <input
            className={field}
            type="number"
            min={1}
            max={100}
            required
            readOnly={Boolean(input.roomSelection)}
            value={
              input.roomSelection
                ? input.roomSelection.lines.reduce((sum, line) => sum + line.guests.length, 0)
                : input.numberOfRooms || 1
            }
            onChange={(e) => change({ numberOfRooms: Number(e.target.value) })}
          />
        </label>
      </div>
      {!partyMatches && (
        <p role="alert" className="text-sm text-red-700">
          {t("partyChanged")}
        </p>
      )}
      <fieldset className="space-y-3">
        <legend className="mb-2 font-semibold">Add-ons</legend>
        {addons.map((addon) => {
          const selected = input.addonIds?.includes(addon.id) ?? false;
          return (
            <div key={addon.id} className="rounded-lg border p-4">
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(e) =>
                    change({
                      addonIds: e.target.checked
                        ? [...(input.addonIds || []), addon.id]
                        : (input.addonIds || []).filter((id) => id !== addon.id),
                    })
                  }
                />
                {addon.name}
              </label>
              {selected && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label>
                    Quantity
                    <input
                      className={field}
                      type="number"
                      min={1}
                      max={addon.maxQuantity || 100}
                      value={input.addonQuantities?.[addon.id] || 1}
                      onChange={(e) =>
                        change({
                          addonQuantities: {
                            ...input.addonQuantities,
                            [addon.id]: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Service dates, if needed
                    <input
                      className={field}
                      placeholder="YYYY-MM-DD, YYYY-MM-DD"
                      defaultValue={(input.addonDates?.[addon.id] || []).join(", ")}
                      onChange={(e) =>
                        change({
                          addonDates: {
                            ...input.addonDates,
                            [addon.id]: e.target.value
                              .split(",")
                              .map((date) => date.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })}
        {(input.addonIds || [])
          .filter((id) => !addons.some((addon) => addon.id === id))
          .map((id) => (
            <label key={id} className="flex items-center gap-3 rounded-lg border p-4">
              <input
                type="checkbox"
                checked
                onChange={() =>
                  change({ addonIds: input.addonIds!.filter((selected) => selected !== id) })
                }
              />
              {details.booking.addonNames?.[details.booking.addonIds?.indexOf(id) ?? -1] ||
                "Previously selected add-on"}{" "}
              (unavailable — deselect to remove)
            </label>
          ))}
        {!addons.length && <p className="text-gray-500">No add-ons are currently available.</p>}
      </fieldset>
      <label className="block">
        Payment method
        <select
          className={field}
          value={input.paymentMethod === "cash" ? "pay_at_property" : input.paymentMethod}
          onChange={(e) => change({ paymentMethod: e.target.value })}
        >
          {methods.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {settings?.specialRequestsEnabled !== false && (
        <label className="block">
          Special requests
          <textarea
            className={field}
            rows={3}
            maxLength={2000}
            value={input.specialRequests || ""}
            onChange={(e) => change({ specialRequests: e.target.value })}
          />
        </label>
      )}
      <button type="submit" className={button} disabled={!partyMatches}>
        Review updated price
      </button>
    </fieldset>
  );
}
