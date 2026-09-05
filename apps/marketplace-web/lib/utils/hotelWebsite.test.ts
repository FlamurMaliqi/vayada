import { describe, expect, it } from "vitest";
import { normalizeHotelWebsite } from "./hotelWebsite";
import { buildHotelProfileDetailsUpdate } from "@/hooks/useHotelProfile";

describe("hotel website input", () => {
  it.each([
    ["name.com", "https://name.com"],
    ["www.name.com", "https://www.name.com"],
    ["https://name.com", "https://name.com"],
    ["http://name.com", "http://name.com"],
    [" name.com ", "https://name.com"],
    ["name.com/rooms?ad=summer#book", "https://name.com/rooms?ad=summer#book"],
    ["HTTPS://Name.com/Rooms?ad=Summer#Book", "HTTPS://Name.com/Rooms?ad=Summer#Book"],
    ["", ""],
  ])("saves %j as %j", (input, expected) => {
    expect(normalizeHotelWebsite(input)).toBe(expected);
    const profile = { name: "Hotel", location: "Berlin", localityPublic: true };
    const payload = buildHotelProfileDetailsUpdate(
      { ...profile, website: "https://old.example" },
      { ...profile, website: input, picture: "", about: "" },
      "",
    );
    expect(payload.website).toBe(expected || null);
  });

  it("does not rewrite an equivalent stored website", () => {
    const profile = { name: "Hotel", location: "Berlin", localityPublic: true };
    expect(
      buildHotelProfileDetailsUpdate(
        { ...profile, website: "https://name.com" },
        { ...profile, website: " name.com ", picture: "", about: "" },
        "",
      ),
    ).toEqual({});
  });

  it.each([
    "name",
    "https://",
    "name .com",
    "na\nme.com",
    "name.com/<invalid>",
    "name_.com",
    "-name.com",
    "name..com",
    "https:///name.com",
    "https://name.com\\path",
    "ftp://name.com",
    "https://user@name.com",
    "https://%6eame.com",
    "name.com:invalid",
  ])("rejects %j", (input) => {
    expect(() => normalizeHotelWebsite(input)).toThrow("Enter a valid website");
  });
});
