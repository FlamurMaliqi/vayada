"use client";

import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import BookingNavigation from "@/components/layout/BookingNavigation";
import BookingFooter from "@/components/layout/BookingFooter";
import PublicStructuredData from "@/components/booking/PublicStructuredData";
import { bookingImageSizes } from "@/components/booking/imageSizes";
import { useHotel, useRooms } from "@/contexts/HotelContext";
import { useCurrency } from "@/contexts/CurrencyContext";

export default function RoomsPage() {
  const locale = useLocale();
  const t = useTranslations("rooms");
  const tc = useTranslations("common");
  const { hotel } = useHotel();
  const { rooms } = useRooms();
  const { formatPrice } = useCurrency();

  return (
    <div className="min-h-screen bg-white">
      <PublicStructuredData hotel={hotel} rooms={rooms} locale={locale} />

      {/* Mini Hero */}
      <div className="relative h-64 w-full">
        <Image
          src={hotel.heroImage}
          alt={hotel.name}
          fill
          className="object-cover"
          priority
          sizes={bookingImageSizes.hero}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />
        <BookingNavigation />
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
          <h1 className="text-4xl md:text-5xl font-heading italic text-white mb-2">{t("title")}</h1>
          <p className="text-white/80 text-lg">{t("subtitle")}</p>
        </div>
      </div>

      {/* Room Grid */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {rooms.map((room) => (
            <div
              key={room.id}
              id={`room-${room.id}`}
              className="bg-white border border-gray-200 rounded-2xl overflow-hidden hover:shadow-lg transition-shadow group"
            >
              {/* Image */}
              <div className="relative h-64 overflow-hidden">
                <Image
                  src={room.images[0]}
                  alt={room.name}
                  fill
                  className="object-cover group-hover:scale-105 transition-transform duration-500"
                  sizes={bookingImageSizes.roomGridCard}
                />
                {room.remainingRooms <= 3 && (
                  <div className="absolute top-3 left-3 bg-red-500 text-white text-xs font-bold px-2.5 py-1 rounded-full">
                    {tc("onlyLeft", { count: room.remainingRooms })}
                  </div>
                )}
              </div>

              {/* Content */}
              <div className="p-6">
                <h3 className="text-xl font-bold text-gray-900 mb-1">{room.name}</h3>
                <p className="text-sm text-gray-500 mb-3">
                  {room.size} m&sup2; &middot; {room.bedType} &middot;{" "}
                  {tc("adults", { count: room.maxOccupancy })}
                </p>
                <p className="text-gray-600 text-sm mb-4">{room.shortDescription}</p>

                {/* Amenities */}
                <div className="flex flex-wrap gap-2 mb-5">
                  {room.amenities.slice(0, 4).map((amenity) => (
                    <span
                      key={amenity}
                      className="px-2.5 py-1 bg-accent text-gray-600 rounded-md text-xs font-medium"
                    >
                      {amenity}
                    </span>
                  ))}
                  {room.amenities.length > 4 && (
                    <span className="px-2.5 py-1 text-primary-600 text-xs font-medium">
                      {tc("more", { count: room.amenities.length - 4 })}
                    </span>
                  )}
                </div>

                {/* Price + CTA */}
                <div className="flex items-end justify-between pt-4 border-t border-gray-100">
                  <div>
                    <p className="text-sm text-gray-500">{tc("from")}</p>
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-bold text-gray-900">
                        {formatPrice(room.baseRate, room.currency)}
                      </span>
                      <span className="text-sm text-gray-500">{tc("perNight")}</span>
                    </div>
                  </div>
                  <Link
                    href={`/?room=${room.id}`}
                    className="px-6 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-sm"
                  >
                    {tc("checkAvailability")}
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <BookingFooter />
    </div>
  );
}
