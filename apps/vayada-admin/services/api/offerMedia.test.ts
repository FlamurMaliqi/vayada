import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOffer: vi.fn(),
  updateOffer: vi.fn(),
  upload: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("./users", () => ({
  usersService: {
    createOffer: mocks.createOffer,
    updateOffer: mocks.updateOffer,
    verifyOffer: mocks.verify,
  },
}));
vi.mock("./upload", () => ({ uploadService: { uploadListingImages: mocks.upload } }));

import {
  createOfferWithMedia,
  OfferMediaPublicationError,
  updateOfferWithMedia,
} from "./offerMedia";

const file = { name: "photo.jpg" } as File;

describe("offer media workflows", () => {
  beforeEach(() => Object.values(mocks).forEach((mock) => mock.mockReset()));

  it("creates a draft before uploading without publishing", async () => {
    const order: string[] = [];
    mocks.createOffer.mockImplementation(async () => {
      order.push("create");
      return { offerId: "offer-801" };
    });
    mocks.upload.mockImplementation(async () => {
      order.push("upload");
      return { mediaObjectIds: ["media-801"] };
    });
    mocks.verify.mockImplementation(async () => order.push("verify"));

    await createOfferWithMedia("hotel-801", { name: "Stay" } as never, [file]);

    expect(order).toEqual(["create", "upload"]);
    expect(mocks.upload).toHaveBeenCalledWith([file], "offer-801");
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("returns the created offer ID with a publication failure so callers do not recreate it", async () => {
    mocks.createOffer.mockResolvedValue({ offerId: "offer-801" });
    mocks.upload.mockRejectedValue(new Error("upload failed"));

    const error = await createOfferWithMedia("hotel-801", { name: "Stay" } as never, [file]).catch(
      (cause) => cause,
    );

    expect(error).toBeInstanceOf(OfferMediaPublicationError);
    expect(error.offerId).toBe("offer-801");
    expect(mocks.createOffer).toHaveBeenCalledOnce();
  });

  it("updates and uploads without implicitly publishing", async () => {
    const order: string[] = [];
    mocks.updateOffer.mockImplementation(async () => order.push("update"));
    mocks.upload.mockImplementation(async () => {
      order.push("upload");
      return { mediaObjectIds: ["media-retry"] };
    });
    mocks.verify.mockImplementation(async () => order.push("verify"));

    await updateOfferWithMedia("hotel-801", "offer-801", {}, [file]);

    expect(order).toEqual(["update", "upload"]);
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
