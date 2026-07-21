import {
  createBookingAddonItem,
  listBookingAddonItems,
  updateBookingAddonItem,
  type BookingAddonItem,
  type CreateBookingAddonItemBody,
} from "@/services/api/bookingAddonItemsClient";
import {
  createBookingPromoCode,
  listBookingPromoCodes,
  updateBookingPromoCode,
  type BookingPromoCode,
  type CreateBookingPromoCodeBody,
} from "@/services/api/bookingPromoCodesClient";

type AddonCatalogClient = {
  list: (input: { hotelId: string }) => Promise<BookingAddonItem[]>;
  create: (input: {
    hotelId: string;
    body: CreateBookingAddonItemBody;
  }) => Promise<BookingAddonItem>;
  update: (input: {
    hotelId: string;
    addonItemId: string;
    body: CreateBookingAddonItemBody;
  }) => Promise<BookingAddonItem>;
};

type PromoCodeCatalogClient = {
  list: (input: { hotelId: string }) => Promise<BookingPromoCode[]>;
  create: (input: {
    hotelId: string;
    body: CreateBookingPromoCodeBody;
  }) => Promise<BookingPromoCode>;
  update: (input: {
    hotelId: string;
    promoCodeId: string;
    body: CreateBookingPromoCodeBody;
  }) => Promise<BookingPromoCode>;
};

const addonCatalogClient: AddonCatalogClient = {
  list: listBookingAddonItems,
  create: createBookingAddonItem,
  update: updateBookingAddonItem,
};

const promoCodeCatalogClient: PromoCodeCatalogClient = {
  list: listBookingPromoCodes,
  create: createBookingPromoCode,
  update: updateBookingPromoCode,
};

function normalizedKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export async function reconcileSetupAddons(
  input: { hotelId: string; addons: CreateBookingAddonItemBody[] },
  client: AddonCatalogClient = addonCatalogClient,
): Promise<void> {
  const existingByName = new Map<string, BookingAddonItem[]>();
  for (const addon of await client.list({ hotelId: input.hotelId })) {
    const key = normalizedKey(addon.name);
    existingByName.set(key, [...(existingByName.get(key) ?? []), addon]);
  }

  for (const addon of input.addons) {
    const matches = existingByName.get(normalizedKey(addon.name));
    const existing = matches?.shift();
    if (existing) {
      await client.update({
        hotelId: input.hotelId,
        addonItemId: existing.addonItemId,
        body: addon,
      });
    } else {
      await client.create({ hotelId: input.hotelId, body: addon });
    }
  }
}

export async function reconcileSetupPromoCodes(
  input: { hotelId: string; promoCodes: CreateBookingPromoCodeBody[] },
  client: PromoCodeCatalogClient = promoCodeCatalogClient,
): Promise<string[]> {
  let existing: BookingPromoCode[];
  try {
    existing = await client.list({ hotelId: input.hotelId });
  } catch {
    return input.promoCodes.map((promoCode) => promoCode.code);
  }

  const existingByCode = new Map(
    existing.map((promoCode) => [normalizedKey(promoCode.code), promoCode]),
  );
  const failedCodes: string[] = [];

  for (const promoCode of input.promoCodes) {
    const current = existingByCode.get(normalizedKey(promoCode.code));
    try {
      if (current) {
        await client.update({
          hotelId: input.hotelId,
          promoCodeId: current.promoCodeId,
          body: promoCode,
        });
      } else {
        await client.create({ hotelId: input.hotelId, body: promoCode });
      }
    } catch {
      failedCodes.push(promoCode.code);
    }
  }

  return failedCodes;
}
