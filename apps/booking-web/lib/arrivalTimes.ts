import type { Hotel } from "./types";

type Times = Pick<Hotel, "checkInTime" | "checkOutTime" | "checkInUntil" | "checkOutFrom">;
export const formatCheckInTime = (hotel: Times) =>
  hotel.checkInUntil ? `${hotel.checkInTime}–${hotel.checkInUntil}` : hotel.checkInTime;
export const formatCheckOutTime = (hotel: Times) =>
  hotel.checkOutFrom ? `${hotel.checkOutFrom}–${hotel.checkOutTime}` : hotel.checkOutTime;
